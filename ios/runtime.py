"""Private loopback bridge for Undertone's WKWebView and bundled music engine."""
import http.server
import json
import mimetypes
from pathlib import Path
import re
import secrets
import shutil
import tempfile
import threading
import urllib.parse

import android_bridge
import device_sync
import offline
import spotify_import
import spotify_job
import updates


class AppServer(http.server.ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, files, cache, web, version):
        self.version = version
        self.files, self.cache, self.web = map(Path, (files, cache, web))
        for directory in (self.files, self.cache, self.files / 'audio'):
            directory.mkdir(parents=True, exist_ok=True)
        android_bridge.configure(files, cache)
        self.prefix = '/' + secrets.token_urlsafe(32) + '/'
        self.jobs = {}
        self.lock = threading.Lock()
        self.phone = None
        port_file = self.files / 'web-port'
        try:
            port = int(port_file.read_text())
            if not 1024 <= port <= 65535:
                port = 0
        except (OSError, ValueError):
            port = 0
        try:
            super().__init__(('127.0.0.1', port), Bridge)
        except OSError:
            super().__init__(('127.0.0.1', 0), Bridge)
        port_file.write_text(str(self.server_port))
        self.host = f'127.0.0.1:{self.server_port}'

    def work(self, kind):
        prefix = kind + '_job_'
        while True:
            with self.lock:
                state = spotify_job.dispatch(self.files, prefix + 'status', {})
                if state['state'] != 'running':
                    self.jobs.pop(kind, None)
                    return
            try:
                spotify_job.dispatch(self.files, prefix + 'step', {'jobId': state['jobId']})
            except Exception:
                spotify_job.dispatch(self.files, prefix + 'pause', {'jobId': state['jobId'], 'reason': 'error'})

    def command(self, operation, args):
        library = self.files / 'library.json'
        if operation == 'app_update' and args.get('operation') in ('status', 'check'):
            return updates.request(args['operation'], self.version, 'ios')
        if operation == 'load_library':
            return json.loads(library.read_bytes()) if library.is_file() else None
        if operation == 'save_library':
            device_sync.atomic_json(library, args['library'])
            return True
        if operation in ('delete_audio', 'has_audio'):
            ident = args['id']
            if not device_sync.LOCAL_NAME.fullmatch(ident):
                raise ValueError('Invalid audio identifier.')
            file = self.files / 'audio' / ident
            if operation == 'delete_audio':
                file.unlink(missing_ok=True)
                return True
            return file.is_file() and file.stat().st_size == args['bytes']
        if operation == 'get_app_icon':
            path = self.files / 'app-icon'
            return path.read_text() if path.is_file() else 'green'
        if operation == 'set_app_icon':
            ident = args.get('id')
            if ident not in ('green', 'blue', 'gray', 'amoled'):
                raise ValueError('Unknown app icon.')
            (self.files / 'app-icon').write_text(ident)
            return ident
        if operation == 'spotify_job':
            request = args.get('operation') or ''
            match = re.fullmatch(r'(spotify|download)_job_(start|resume|pause|status|results|ack)', request)
            if not match:
                raise ValueError('Unknown background job request.')
            kind, action = match.groups()
            with self.lock:
                state = spotify_job.dispatch(self.files, request, args.get('args') or {})
                if action in ('start', 'resume') and state.get('state') == 'running' and kind not in self.jobs:
                    self.jobs[kind] = threading.Thread(target=self.work, args=(kind,), daemon=True)
                    self.jobs[kind].start()
                if 'state' in state:
                    state['serviceActive'] = kind in self.jobs
            return state
        if operation in ('link_phone_start', 'link_phone_status', 'link_phone_stop'):
            with self.lock:
                if operation == 'link_phone_start' and self.phone is None:
                    try:
                        self.phone = device_sync.PhonePresence('iPhone')
                    except OSError:
                        pass
                if operation == 'link_phone_stop' and self.phone is not None:
                    self.phone.close()
                    self.phone = None
                return {'available': self.phone is not None, 'running': self.phone is not None,
                        'invitation': self.phone.take_invitation() if self.phone else None}
        if operation in ('music', 'list_downloads', 'offline_file', 'remove_download',
                         'link_status', 'link_discover', 'link_pair', 'link_forget', 'link_pull'):
            return android_bridge.dispatch(operation, args)
        raise ValueError('Unknown iOS request.')


class Bridge(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def route(self):
        path = urllib.parse.unquote(urllib.parse.urlsplit(self.path).path)
        if self.headers.get('Host') == self.server.host and path.startswith(self.server.prefix):
            return path[len(self.server.prefix):]
        return ''

    def file_headers(self, status, mime, size):
        self.send_response(status)
        self.send_header('Content-Type', mime)
        self.send_header('Content-Length', str(size))
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
                         "img-src 'self' data: blob: https:; media-src 'self' blob: https:; connect-src 'self'; "
                         "object-src 'none'; frame-src 'none'; base-uri 'self'")

    def local_file(self, route):
        if route.startswith('audio/'):
            name = route.removeprefix('audio/')
            if device_sync.LOCAL_NAME.fullmatch(name):
                base = self.server.files / 'audio'
            elif offline.audio_name(name):
                base = self.server.files / 'downloads'
            else:
                return None
        else:
            base = self.server.web
            name = route
        file = (base / name).resolve()
        if file.is_relative_to(base.resolve()) and file.is_file():
            return file
        return None

    def get_file(self, *, head=False):
        route = self.route()
        file = self.local_file(route) if route else None
        if file is None:
            self.send_error(404)
            return
        with file.open('rb') as source:
            size = file.stat().st_size
            first, last = 0, size - 1
            byte_range = self.headers.get('Range')
            if byte_range:
                match = re.fullmatch(r'bytes=(\d*)-(\d*)', byte_range)
                if match and (match[1] or match[2]):
                    if match[1]:
                        first = int(match[1])
                        last = min(last, int(match[2])) if match[2] else last
                    else:
                        first = max(0, size - int(match[2]))
                if not match or not (match[1] or match[2]) or not 0 <= first <= last:
                    self.send_response(416)
                    self.send_header('Content-Range', f'bytes */{size}')
                    self.end_headers()
                    return
            mime = 'text/javascript' if file.suffix == '.js' else mimetypes.guess_type(file.name)[0] or 'application/octet-stream'
            self.file_headers(206 if byte_range else 200, mime, last - first + 1)
            self.send_header('Accept-Ranges', 'bytes')
            if byte_range:
                self.send_header('Content-Range', f'bytes {first}-{last}/{size}')
            self.end_headers()
            if not head:
                source.seek(first)
                left = last - first + 1
                try:
                    while left and (block := source.read(min(left, 128 * 1024))):
                        self.wfile.write(block)
                        left -= len(block)
                except OSError:
                    pass

    def do_GET(self):
        self.get_file()

    def do_HEAD(self):
        self.get_file(head=True)

    def upload(self, destination, size):
        with destination.open('wb') as file:
            while size:
                block = self.rfile.read(min(size, 128 * 1024))
                if not block:
                    raise ValueError('The file upload was interrupted.')
                file.write(block)
                size -= len(block)

    def do_POST(self):
        route = self.route()
        if self.headers.get('Origin') not in (None, f'http://{self.server.host}') or not route.startswith('bridge/'):
            self.send_error(404)
            return
        try:
            size = int(self.headers['Content-Length'])
            if not 0 < size <= 256 * 1024 * 1024:
                raise ValueError('The file is too large.')
            operation = route.removeprefix('bridge/')
            if operation == 'parse_spotify' and size <= 32 * 1024 * 1024:
                with tempfile.TemporaryDirectory(dir=self.server.cache) as folder:
                    path = Path(folder) / 'export'
                    self.upload(path, size)
                    data = spotify_import.parse(path, urllib.parse.unquote(self.headers.get('x-import-name', '')))
            elif operation == 'save_audio':
                ident = self.headers.get('x-audio-id', '')
                if not device_sync.LOCAL_NAME.fullmatch(ident):
                    raise ValueError('Invalid audio identifier.')
                target = self.server.files / 'audio' / ident
                with tempfile.TemporaryDirectory(dir=target.parent) as folder:
                    partial = Path(folder) / 'audio'
                    self.upload(partial, size)
                    partial.replace(target)
                data = str(target)
            elif size <= 64 * 1024 * 1024:
                data = self.server.command(operation, json.loads(self.rfile.read(size)))
            else:
                raise ValueError('The request is too large.')
            reply = {'data': data}
        except (ValueError, OSError) as error:
            reply = {'error': str(error)}
        except Exception:
            reply = {'error': 'This request couldn’t finish. Try again.'}
        body = json.dumps(reply, ensure_ascii=False).encode('utf-8')
        self.file_headers(200, 'application/json; charset=utf-8', len(body))
        self.end_headers()
        try:
            self.wfile.write(body)
        except OSError:
            pass


def start(files, cache, web, version):
    server = AppServer(files, cache, web, version)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return f'http://{server.host}{server.prefix}index.html'
