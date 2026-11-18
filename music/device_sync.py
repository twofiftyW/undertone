"""An opt-in, pinned-TLS LAN copy of the PC library. No cloud account or uploads."""
from __future__ import annotations
import copy
import hashlib
import hmac
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import ipaddress
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import socket
import ssl
import subprocess
import sys
import threading
import time

MAX_LIBRARY = 64 * 1024 * 1024
MAX_AUDIO = 512 * 1024 * 1024
LOCAL_NAME = re.compile(r'[a-f0-9]{64}\.[a-z0-9]{1,10}\Z')
DOWNLOAD_NAME = re.compile(r'(?:\d{17,20}\.flac|youtube-[A-Za-z0-9_-]{11}\.(?:m4a|webm|opus|mp3|ogg))\Z')


def digest(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def atomic_json(path, data):
    path = Path(path)
    temporary = path.with_suffix('.tmp')
    with temporary.open('w') as out:
        os.chmod(temporary, 0o600)
        json.dump(data, out, ensure_ascii=False)
        out.flush()
        os.fsync(out.fileno())
    temporary.replace(path)


def lan_address(value):
    try:
        address = ipaddress.ip_address(value)
        return address.version == 4 and (address.is_loopback or any(address in ipaddress.ip_network(block) for block in ('10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '169.254.0.0/16')))
    except ValueError:
        return False


def manifest(root, device_id):
    root = Path(root).resolve()
    library_path = root / 'library.json'
    if library_path.stat().st_size > MAX_LIBRARY:
        raise ValueError('The PC library is too large to copy.')
    library = json.loads(library_path.read_text())
    if library.get('version') != 1 or not isinstance(library.get('tracks'), dict):
        raise ValueError('The PC library could not be read.')
    library = copy.deepcopy(library)
    files = []
    library['downloads'] = {}
    for track_id, track in library['tracks'].items():
        track.pop('nativePath', None)
        track.pop('uri', None)
        folder = 'audio' if track.get('source') == 'local' else 'downloads'
        if folder == 'audio':
            name = str(track.get('fileId') or '')
            names = [name] if LOCAL_NAME.fullmatch(name) else []
        elif track.get('source') == 'monochrome' and re.fullmatch(r'\d{17,20}', str(track.get('remoteId') or '')):
            names = [str(track['remoteId']) + '.flac']
        elif track.get('source') == 'youtube' and re.fullmatch(r'[A-Za-z0-9_-]{11}', str(track.get('remoteId') or '')):
            names = ['youtube-' + track['remoteId'] + '.' + ext for ext in ('m4a', 'webm', 'opus', 'mp3', 'ogg')]
        else:
            names = []
        for name in names:
            path = root / folder / name
            if not path.is_file() or path.is_symlink() or path.resolve().parent != root / folder or not 0 < path.stat().st_size <= MAX_AUDIO:
                continue
            key = hashlib.sha256((folder + '/' + name).encode()).hexdigest()
            files.append({'key': key, 'folder': folder, 'name': name, 'trackId': track_id, 'bytes': path.stat().st_size, 'sha256': digest(path)})
            break
    library.pop('pcLink', None)
    return {'version': 1, 'deviceId': device_id, 'library': library, 'files': files, 'bytes': sum(f['bytes'] for f in files)}


def certificate(root):
    directory = Path(root) / 'link'
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    key = directory / 'server.key'
    cert = directory / 'server.crt'
    if not key.is_file() or not cert.is_file():
        if os.name == 'nt':
            from datetime import datetime, timedelta, timezone
            from cryptography import x509
            from cryptography.hazmat.primitives import hashes, serialization
            from cryptography.hazmat.primitives.asymmetric import ec
            private_key = ec.generate_private_key(ec.SECP256R1())
            name = x509.Name([x509.NameAttribute(x509.NameOID.COMMON_NAME, 'Undertone PC')])
            now = datetime.now(timezone.utc)
            certificate = (x509.CertificateBuilder().subject_name(name).issuer_name(name)
                           .public_key(private_key.public_key()).serial_number(x509.random_serial_number())
                           .not_valid_before(now - timedelta(minutes=5)).not_valid_after(now + timedelta(days=3650))
                           .sign(private_key, hashes.SHA256()))
            key.write_bytes(private_key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
            cert.write_bytes(certificate.public_bytes(serialization.Encoding.PEM))
        else:
            subprocess.run(['openssl', 'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', str(key), '-out', str(cert), '-days', '3650', '-subj', '/CN=Undertone PC'], check=True, capture_output=True, timeout=15)
        key.chmod(0o600)
    fingerprint = hashlib.sha256(ssl.PEM_cert_to_DER_cert(cert.read_text())).hexdigest()
    return key, cert, fingerprint


class LibraryServer(ThreadingHTTPServer):
    daemon_threads = True
    block_on_close = False
    allow_reuse_address = True

    def __init__(self, root, host='0.0.0.0', port=0):
        self.root = Path(root).resolve()
        key, cert, self.fingerprint = certificate(self.root)
        self.state_path = self.root / 'link' / 'devices.json'
        try:
            self.devices = json.loads(self.state_path.read_text())
        except (OSError, ValueError):
            self.devices = {'deviceId': secrets.token_hex(16), 'tokens': []}
        self.lock = threading.Lock()
        self.pin = f'{secrets.randbelow(1000000):06d}'
        self.expires = time.time() + 600
        self.attempts = 0
        self.allowed_files = {}
        self.last_client = ''
        super().__init__((host, port), Handler)
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.minimum_version = ssl.TLSVersion.TLSv1_2
        context.load_cert_chain(cert, key)
        self.socket = context.wrap_socket(self.socket, server_side=True)

    def details(self):
        addresses = []
        networks = []
        try:
            if os.name == 'nt':
                addresses = list(dict.fromkeys(entry[4][0] for entry in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET) if lan_address(entry[4][0]) and not entry[4][0].startswith('127.')))
            else:
                raw = subprocess.check_output(['ip', '-j', '-4', 'addr', 'show', 'up'], timeout=3)
                for interface in json.loads(raw):
                    for address in interface.get('addr_info', []):
                        if address.get('scope') == 'global' and lan_address(address['local']):
                            addresses.append(address['local'])
                            networks.append(str(ipaddress.ip_network(f"{address['local']}/{address['prefixlen']}", strict=False)))
        except (OSError, ValueError, subprocess.SubprocessError):
            pass
        prefix = self.fingerprint[:16]
        try:
            firewall = 'ENABLED=yes' in Path('/etc/ufw/ufw.conf').read_text()
        except OSError:
            firewall = False
        return {'running': True, 'addresses': [f'{a}:{self.server_port}' for a in addresses], 'networks': networks, 'firewall': firewall, 'code': '-'.join([prefix[:4], prefix[4:8], prefix[8:12], prefix[12:], self.pin]), 'expires': int(self.expires * 1000), 'pairedDevices': len(self.devices['tokens'])}


class Handler(BaseHTTPRequestHandler):
    server: LibraryServer
    protocol_version = 'HTTP/1.1'

    def log_message(self, *args): pass

    def handle(self):
        try:
            super().handle()
        except (OSError, ssl.SSLError):
            self.close_connection = True

    def setup(self):
        super().setup()
        self.connection.settimeout(30)

    def reply(self, status, data):
        body = json.dumps(data, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Connection', 'close')
        self.end_headers()
        self.wfile.write(body)
        self.close_connection = True

    def authorized(self):
        token = self.headers.get('Authorization', '').removeprefix('Bearer ')
        hashed = hashlib.sha256(token.encode()).hexdigest()
        return lan_address(self.client_address[0]) and any(hmac.compare_digest(hashed, item['hash']) for item in self.server.devices['tokens'])

    def do_POST(self):
        if self.path != '/pair' or not lan_address(self.client_address[0]):
            self.reply(404, {'error': 'Not found'})
            return
        try:
            length = int(self.headers.get('Content-Length') or '0')
            if not 0 < length <= 1024:
                raise ValueError()
            request = json.loads(self.rfile.read(length))
            with self.server.lock:
                self.server.attempts += 1
                if self.server.attempts > 20 or time.time() > self.server.expires or not hmac.compare_digest(str(request.get('code') or ''), self.server.pin):
                    self.reply(403, {'error': 'Pairing code expired or incorrect. Reopen Connect phone on the PC.'})
                    return
                token = secrets.token_urlsafe(32)
                self.server.devices['tokens'].append({'hash': hashlib.sha256(token.encode()).hexdigest(), 'name': str(request.get('name') or 'Android phone')[:80]})
                self.server.devices['tokens'] = self.server.devices['tokens'][-8:]
                atomic_json(self.server.state_path, self.server.devices)
                # This code pairs one phone. Previously paired phones keep working.
                self.server.expires = 0
                self.reply(200, {'token': token, 'fingerprint': self.server.fingerprint, 'deviceId': self.server.devices['deviceId']})
        except (ValueError, OSError):
            self.reply(400, {'error': 'Invalid pairing request'})

    def do_GET(self):
        if not self.authorized():
            self.reply(401, {'error': 'Pair this phone with Undertone on your PC first.'})
            return
        try:
            if self.path == '/library':
                data = manifest(self.server.root, self.server.devices['deviceId'])
                self.server.allowed_files = {f['key']: f for f in data['files']}
                self.reply(200, data)
            elif self.path.startswith('/audio/'):
                key = self.path.removeprefix('/audio/')
                entry = self.server.allowed_files.get(key)
                if not entry:
                    self.reply(404, {'error': 'Refresh the PC library first.'})
                    return
                path = self.server.root / entry['folder'] / entry['name']
                if path.is_symlink() or path.resolve().parent != self.server.root / entry['folder'] or path.stat().st_size != entry['bytes']:
                    raise ValueError('This file changed. Refresh the PC library.')
                self.send_response(200)
                self.send_header('Content-Type', 'application/octet-stream')
                self.send_header('Content-Length', str(entry['bytes']))
                self.send_header('Cache-Control', 'no-store')
                self.send_header('Connection', 'close')
                self.end_headers()
                with path.open('rb') as source:
                    shutil.copyfileobj(source, self.wfile, 128 * 1024)
                self.close_connection = True
            else:
                self.reply(404, {'error': 'Not found'})
        except (OSError, ValueError) as error:
            self.reply(409, {'error': str(error)})


def connection(address, pin, token='', path='/library', body=None):
    """Check the certificate BEFORE sending the pairing PIN or saved token."""
    match = re.fullmatch(r'(\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})', str(address).strip())
    if not match or not lan_address(match[1]) or not 1 <= int(match[2]) <= 65535 or not re.fullmatch(r'[a-f0-9]{16}|[a-f0-9]{64}', pin):
        raise ValueError('Enter the local PC address and pairing code shown in Undertone.')
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    context.check_hostname = False
    context.verify_mode = ssl.CERT_NONE  # Identity is pinned below, before HTTP.
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    client = http.client.HTTPSConnection(match[1], int(match[2]), context=context, timeout=30)
    try:
        client.connect()
        fingerprint = hashlib.sha256(client.sock.getpeercert(binary_form=True)).hexdigest()
        if not hmac.compare_digest(fingerprint[:len(pin)], pin):
            raise ValueError('The pairing code belongs to a different PC. Check it again.')
        payload = json.dumps(body).encode() if body is not None else None
        headers = {'Content-Type': 'application/json'}
        if token:
            headers['Authorization'] = 'Bearer ' + token
        client.request('POST' if body is not None else 'GET', path, payload, headers)
        response = client.getresponse()
        if response.status != 200:
            data = json.loads(response.read(4096))
            raise ValueError(data.get('error') or 'The PC could not complete this request.')
        return client, response, fingerprint
    except Exception:
        client.close()
        raise


def pair(root, address, code):
    clean = re.sub(r'[\s-]', '', str(code)).lower()
    if not re.fullmatch(r'[a-f0-9]{16}\d{6}', clean):
        raise ValueError('Enter the complete pairing code shown on your PC.')
    client, response, fingerprint = connection(address, clean[:16], path='/pair', body={'code': clean[16:], 'name': 'Android phone'})
    try:
        data = json.loads(response.read(4096))
        if data.get('fingerprint') != fingerprint:
            raise ValueError('The PC identity changed during pairing.')
        data['address'] = str(address).strip()
        atomic_json(Path(root) / 'pc-link.json', data)
        return {'paired': True, 'address': data['address']}
    finally:
        client.close()


def pull(root, include_audio=True, progress=None):
    root = Path(root).resolve()
    try:
        link = json.loads((root / 'pc-link.json').read_text())
    except (OSError, ValueError) as error:
        raise ValueError('Pair this phone with your PC first.') from error
    client, response, _ = connection(link['address'], link['fingerprint'], link['token'])
    try:
        raw = response.read(MAX_LIBRARY + 1)
        if len(raw) > MAX_LIBRARY:
            raise ValueError('The PC library is too large to copy.')
        data = json.loads(raw)
    finally:
        client.close()
    if data.get('version') != 1 or data.get('deviceId') != link['deviceId'] or not isinstance(data.get('files'), list) or len(data['files']) > 20000:
        raise ValueError('The PC returned an unsupported library.')
    library = data['library']
    copied = 0
    for index, entry in enumerate(data['files']):
        folder, name = entry.get('folder'), str(entry.get('name') or '')
        if not ((folder == 'audio' and LOCAL_NAME.fullmatch(name)) or (folder == 'downloads' and DOWNLOAD_NAME.fullmatch(name))):
            raise ValueError('The PC returned an invalid audio filename.')
        if not isinstance(entry.get('bytes'), int) or not 0 < entry['bytes'] <= MAX_AUDIO or not re.fullmatch(r'[a-f0-9]{64}', str(entry.get('sha256') or '')) or not re.fullmatch(r'[a-f0-9]{64}', str(entry.get('key') or '')):
            raise ValueError('The PC returned invalid audio information.')
        directory = root / folder
        directory.mkdir(exist_ok=True)
        destination = directory / name
        present = destination.is_file() and destination.stat().st_size == entry['bytes'] and digest(destination) == entry['sha256']
        if include_audio and not present:
            if shutil.disk_usage(root).free < entry['bytes'] + 40 * 1024 * 1024:
                raise ValueError('The phone needs more free space to copy these songs. Try copying playlists only.')
            if progress:
                progress(index, len(data['files']), name)
            temporary = destination.with_suffix(destination.suffix + '.part')
            client, response, _ = connection(link['address'], link['fingerprint'], link['token'], '/audio/' + entry['key'])
            try:
                written = 0
                hasher = hashlib.sha256()
                with temporary.open('wb') as out:
                    while chunk := response.read(128 * 1024):
                        written += len(chunk)
                        if written > entry['bytes']:
                            raise ValueError('The PC returned an incorrect audio size.')
                        hasher.update(chunk)
                        out.write(chunk)
                    out.flush()
                    os.fsync(out.fileno())
                if written != entry['bytes'] or hasher.hexdigest() != entry['sha256']:
                    raise ValueError('This audio copy was interrupted. Tap Copy from PC to retry.')
                temporary.replace(destination)
                copied += 1
                present = True
            finally:
                temporary.unlink(missing_ok=True)
                client.close()
        track = library['tracks'].get(entry['trackId'])
        if present and track:
            if folder == 'audio':
                track['nativePath'] = str(destination)
            else:
                library['downloads'][entry['trackId']] = {'nativePath': str(destination), 'bytes': entry['bytes']}
    return {'library': library, 'deviceId': data['deviceId'], 'copied': copied, 'files': len(data['files'])}


def serve(root):
    root = Path(root)
    root.mkdir(parents=True, exist_ok=True)
    # Fixed port keeps a paired phone usable when Undertone is reopened.
    server = LibraryServer(root, port=47832)
    print(json.dumps({'data': server.details()}), flush=True)
    def watch_parent():
        sys.stdin.read(1)  # The app holds this pipe open for the lifetime of the connection.
        server.shutdown()
    threading.Thread(target=watch_parent, daemon=True).start()
    try:
        server.serve_forever(poll_interval=0.5)
    finally:
        server.server_close()
