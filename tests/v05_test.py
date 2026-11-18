"""Provider fallback and a real local TLS library/audio transfer, without cloud services."""
import copy
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'music'))
import backend, monochrome, device_sync, android_bridge

seed = {'artist': 'DVRST', 'title': 'Close Eyes', 'duration': 132}
youtube = {'id': 'youtube:ao4RCon11eY', 'remoteId': 'ao4RCon11eY', 'source': 'youtube', 'kind': 'song', 'title': 'Close Eyes', 'artist': 'DVRST', 'artists': [{'name': 'DVRST', 'id': ''}], 'duration': 132, 'album': {'title': ''}}
mono = {**youtube, 'id': 'monochrome:159277913216937984', 'remoteId': '159277913216937984', 'source': 'monochrome'}
with tempfile.TemporaryDirectory() as folder, patch.object(backend, 'CACHE', Path(folder)):
    with patch.object(monochrome, 'match_recording', return_value={'track': mono, 'candidates': [mono]}), patch.object(backend, 'youtube_search', side_effect=AssertionError('A matched song searched YouTube')):
        assert backend.match_recording(seed)['track'] == mono
    with patch.object(monochrome, 'match_recording', return_value={'track': None, 'candidates': []}), patch.object(backend, 'youtube_search', return_value=[youtube]):
        assert backend.match_recording(seed)['track'] == youtube
    assert monochrome.choose_recording(seed, [{**youtube, 'title': 'Close Eyes (Slowed)'}])['track'] is None
    assert monochrome.choose_recording(seed, [{**youtube, 'artists': [{'name': 'Someone else'}], 'artist': 'Someone else'}])['track'] is None
    with patch.object(monochrome, 'search', return_value={'tracks': [], 'artists': [], 'albums': []}), patch.object(backend, 'youtube_search', return_value=[youtube]):
        assert backend.dispatch('search', {'query': 'DVRST Close Eyes', 'force': True})['tracks'] == [youtube]
    with patch.object(monochrome, 'search', return_value={'tracks': [{**mono, 'title': 'Dream Space'}], 'artists': [], 'albums': []}), patch.object(backend, 'youtube_search', return_value=[youtube]):
        assert backend.dispatch('search', {'query': 'DVRST Close Eyes', 'force': True})['tracks'][0] == youtube
    with patch.object(monochrome, 'search', return_value={'tracks': [mono], 'artists': [], 'albums': []}), patch.object(backend, 'youtube_search', side_effect=AssertionError('A relevant Monochrome result searched YouTube')):
        assert backend.dispatch('search', {'query': 'DVRST Close Eyes', 'force': True})['tracks'] == [mono]
    with patch.object(backend, 'resolve', return_value={'url': 'https://test.googlevideo.com/audio'}):
        assert backend.dispatch('resolve', {'source': 'youtube', 'id': youtube['remoteId'], 'track': youtube, 'force': True})['url'].endswith('/audio')
print('Monochrome stays first; missing songs search YouTube; wrong artists and versions are not auto-matched.')

with tempfile.TemporaryDirectory() as folder:
    pc = Path(folder) / 'pc'; phone = Path(folder) / 'phone'
    pc.mkdir(); phone.mkdir()
    (pc / 'downloads').mkdir(); (pc / 'audio').mkdir()
    audio_id = 'a' * 64 + '.wav'
    local = {'id': 'local:test', 'source': 'local', 'fileId': audio_id, 'title': 'My recording', 'nativePath': str(pc / 'audio' / audio_id)}
    library = {'version': 1, 'tracks': {mono['id']: mono, youtube['id']: youtube, local['id']: local}, 'liked': [mono['id']], 'imports': [local['id']], 'playlists': [{'id': 'example', 'name': 'A playlist', 'trackIds': [youtube['id'], mono['id'], youtube['id']]}], 'recent': [], 'followedArtists': [], 'downloads': {}, 'volume': 0.4}
    (pc / 'library.json').write_text(json.dumps(library))
    (pc / 'downloads' / (mono['remoteId'] + '.flac')).write_bytes(b'fLaC' + b'x' * 300000)
    (pc / 'downloads' / ('youtube-' + youtube['remoteId'] + '.m4a')).write_bytes(b'\0\0\0\x18ftyp' + b'x' * 200000)
    (pc / 'audio' / audio_id).write_bytes(b'RIFF' + b'w' * 100000)
    server = device_sync.LibraryServer(pc, '127.0.0.1', 0)
    thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
    address = f'127.0.0.1:{server.server_port}'
    try:
        try:
            device_sync.connection(address, '0' * 16, path='/pair', body={'code': server.pin})
            raise AssertionError('Wrong PC identity was accepted')
        except ValueError:
            assert server.attempts == 0, 'Credentials were sent before checking the PC certificate'
        try:
            device_sync.connection(address, server.fingerprint)
            raise AssertionError('Unauthenticated library access succeeded')
        except ValueError:
            pass
        result = device_sync.pair(phone, address, server.details()['code'])
        assert result['paired'] and (phone / 'pc-link.json').is_file()
        if os.name == 'posix':
            assert (phone / 'pc-link.json').stat().st_mode & 0o777 == 0o600
        data = device_sync.pull(phone, include_audio=False)
        assert data['copied'] == 0 and len(data['library']['playlists']) == 1
        assert 'nativePath' not in data['library']['tracks'][local['id']]
        android_bridge.configure(str(phone), str(phone / 'cache'))
        local_record = data['library']['tracks'][local['id']]
        restored = phone / 'audio' / local_record['fileId']
        restored.write_bytes((pc / 'audio' / audio_id).read_bytes())
        assert android_bridge.dispatch('resolve_track', {'track': local_record})['url'] == str(restored)
        restored.unlink()
        data = device_sync.pull(phone)
        assert data['copied'] == 3
        assert data['library']['playlists'][0]['trackIds'] == library['playlists'][0]['trackIds']
        assert data['library']['tracks'][local['id']]['nativePath'].startswith(str(phone))
        assert len(data['library']['downloads']) == 2
        assert device_sync.pull(phone)['copied'] == 0, 'A repeated sync redownloaded completed files'
        android_bridge.configure(str(phone), str(phone / 'cache'))
        with patch.object(backend, 'dispatch', side_effect=AssertionError('Offline Android playback tried the network')), patch.object(Path, 'iterdir', side_effect=AssertionError('Playback scanned every download')):
            assert android_bridge.dispatch('resolve_track', {'track': mono})['offline'] is True
            assert android_bridge.dispatch('resolve_track', {'track': youtube})['offline'] is True
            assert android_bridge.dispatch('resolve_track', {'track': local})['url'].startswith(str(phone))
            assert android_bridge.dispatch('offline_file', {'id': '111111111111111111'}) is None
            assert android_bridge.dispatch('offline_file', {'id': '../audio/' + local_record['fileId']}) is None
        link = json.loads((phone / 'pc-link.json').read_text())
        snapshot = device_sync.manifest(pc, link['deviceId'])
        invalid = copy.deepcopy(snapshot); invalid['files'][0]['folder'] = '../outside'
        with patch.object(device_sync, 'manifest', return_value=invalid):
            try: device_sync.pull(phone); raise AssertionError('Unsafe filename was accepted')
            except ValueError as error: assert 'filename' in str(error)
        corrupt = copy.deepcopy(snapshot); corrupt['files'][0]['sha256'] = '0' * 64
        original = phone / corrupt['files'][0]['folder'] / corrupt['files'][0]['name']
        before = device_sync.digest(original)
        with patch.object(device_sync, 'manifest', return_value=corrupt):
            try: device_sync.pull(phone); raise AssertionError('Damaged audio was accepted')
            except ValueError as error: assert 'interrupted' in str(error)
        assert device_sync.digest(original) == before and not list(phone.rglob('*.part'))
    finally:
        server.shutdown(); server.server_close(); thread.join(timeout=5)
assert device_sync.lan_address('192.168.1.2') and not device_sync.lan_address('8.8.8.8') and not device_sync.lan_address('0.0.0.0')
print('Pinned-TLS pairing, access control, playlist order, audio checksums, repeat-copy skips, offline Android resolution, and unsafe/interrupted-copy rejection passed.')
