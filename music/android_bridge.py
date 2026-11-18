"""JSON entry point for the same music engine bundled in the Android APK."""
import json
import os
from pathlib import Path
import re

ROOT = None
IMPORTS = None
OPERATIONS = {'search', 'fallback', 'videos', 'artist', 'discography', 'album', 'recommendations', 'resolve', 'home', 'match', 'spotify_url'}


def configure(files, cache):
    global ROOT, IMPORTS
    ROOT = Path(files).resolve()
    IMPORTS = Path(cache) / 'spotify-imports'
    os.environ['UNDERTONE_CACHE_DIR'] = str(Path(cache) / 'music')
    os.environ['UNDERTONE_DOWNLOAD_DIR'] = str(ROOT / 'downloads')
    return True


def offline_files():
    import offline
    result = {}
    directory = ROOT / 'downloads'
    directory.mkdir(exist_ok=True)
    for path in directory.iterdir():
        if not path.is_file() or not offline.audio_name(path.name) or path.stat().st_size <= 8:
            continue
        with path.open('rb') as stream:
            if not offline.valid_header(stream.read(16), path.suffix):
                continue
        ident = 'youtube:' + path.stem.removeprefix('youtube-') if path.name.startswith('youtube-') else 'monochrome:' + path.stem
        result[ident] = {'nativePath': str(path), 'bytes': path.stat().st_size}
    return result


def dispatch(operation, args):
    import backend
    import device_sync
    if operation.startswith('spotify_job_'):
        import spotify_job
        return spotify_job.dispatch(ROOT, operation, args)
    if operation == 'music':
        if args.get('operation') not in OPERATIONS:
            raise ValueError('Unknown music request')
        return backend.dispatch(args['operation'], args.get('args') or {})
    if operation == 'list_downloads':
        return offline_files()
    if operation == 'offline_file':
        return offline_files().get(str(args.get('source') or 'monochrome') + ':' + str(args.get('id') or ''))
    if operation == 'download_track':
        return backend.dispatch('download', args)
    if operation == 'remove_download':
        entry = dispatch('offline_file', args)
        if entry:
            Path(entry['nativePath']).unlink(missing_ok=True)
        return True
    if operation == 'resolve_track':
        track = args['track']
        if track.get('source') == 'audius' and re.fullmatch(r'[A-Za-z0-9]{1,100}', str(track.get('remoteId') or '')):
            return {'url': 'https://discoveryprovider.audius.co/v1/tracks/' + track['remoteId'] + '/stream?app_name=UndertonePersonal'}
        if track.get('source') == 'local':
            file_id = str(track.get('fileId') or '')
            if not device_sync.LOCAL_NAME.fullmatch(file_id):
                raise ValueError('This local audio file is missing. Copy it from your PC again.')
            path = ROOT / 'audio' / file_id
            if not path.is_file():
                raise ValueError('This local file isn’t on your phone. Copy saved audio from your PC first.')
            return {'url': str(path)}
        saved = dispatch('offline_file', {'id': track.get('remoteId'), 'source': track.get('source')})
        if saved:
            return {'url': saved['nativePath'], 'offline': True}
        return backend.dispatch('resolve', {'id': track.get('remoteId'), 'source': track.get('source'), 'track': track})
    if operation == 'parse_spotify':
        token = args.get('token', '')
        if not re.fullmatch(r'[a-f0-9]{32}', token):
            raise ValueError('Invalid Spotify import session')
        directory = IMPORTS / token
        path = directory / 'export'
        try:
            return backend.dispatch('spotify_parse_pages', {'path': str(path), 'filename': args.get('filename')})
        finally:
            path.unlink(missing_ok=True)
    if operation == 'link_discover':
        targets = [(address, device_sync.LINK_PORT) for address in args.get('broadcasts', [])]
        return device_sync.discover(targets=targets or None)
    if operation == 'link_status':
        try:
            state = json.loads((ROOT / 'pc-link.json').read_text())
            data = {'paired': True, 'address': state['address']}
        except (OSError, ValueError, KeyError):
            data = {'paired': False}
        try:
            data.update(json.loads((ROOT / 'link-progress.json').read_text()))
        except (OSError, ValueError):
            pass
        return data
    if operation == 'link_pair':
        return device_sync.pair(ROOT, str(args.get('address') or ''), str(args.get('code') or ''))
    if operation == 'link_forget':
        (ROOT / 'pc-link.json').unlink(missing_ok=True)
        (ROOT / 'link-progress.json').unlink(missing_ok=True)
        return True
    if operation == 'link_pull':
        def progress(done, total, name):
            device_sync.atomic_json(ROOT / 'link-progress.json', {'running': True, 'done': done, 'total': total})
        progress(0, 0, '')
        try:
            return device_sync.pull(ROOT, args.get('audio', True) is not False, progress)
        finally:
            device_sync.atomic_json(ROOT / 'link-progress.json', {'running': False})
    raise ValueError('Unknown phone request')


def handle(operation, payload):
    try:
        return json.dumps({'data': dispatch(operation, json.loads(payload))}, ensure_ascii=False)
    except Exception as error:
        message = str(error) if isinstance(error, (ValueError, OSError)) else 'This request couldn’t finish. Check your connection and retry.'
        return json.dumps({'error': message}, ensure_ascii=False)
