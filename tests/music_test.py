"""Local catalog checks without external network or private library access."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import sys
import threading
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'music'))
from backend import cached, dispatch, track as video_track, youtube_search
from monochrome import track, release, artist_card, identifier, request, unique

person = {'id': 'mono:artist:152942198986379264', 'name': 'DVRST'}
album = release({'releaseId': '304193265622626304', 'title': 'Echoes of Childhood II', 'releaseType': 'ALBUM', 'releaseDate': '2026-04-17T00:00:00.000Z'}, [person])
song = {'trackId': '304193265622626305', 'title': 'Game Over', 'duration': 127000, 'playable': True}
normalized = track(song, [person], album)
assert normalized['id'] == 'monochrome:304193265622626305'
assert normalized['duration'] == 127
assert normalized['artists'] == [person]
assert normalized['album']['id'] == album['id']
assert album['year'] == '2026' and album['type'] == 'Album'
assert track({**song, 'playable': False}) is None
assert track({**song, 'trackId': '../../private'}) is None
assert identifier('mono:artist:152942198986379264', 'artist') == '152942198986379264'
assert artist_card({'artistId': '152942198986379264', 'displayName': 'DVRST'})['id'] == person['id']
assert len(unique([normalized, normalized, None])) == 1
assert video_track({'videoId': 'abcdefghijk', 'title': 'Music Video', 'videoType': 'MUSIC_VIDEO_TYPE_OMV'})['kind'] == 'video'
assert dispatch('search', {'query': ''}) == {'tracks': [], 'artists': [], 'albums': []}
for operation, args in [('resolve', {'id': '--exec'}), ('artist', {'id': '../../etc/passwd'}), ('album', {'id': 'UCnotanalbum'}), ('not-an-operation', {})]:
    try:
        dispatch(operation, args)
        raise AssertionError('Invalid request was accepted')
    except ValueError:
        pass
print('Monochrome metadata, string IDs, inherited album credits, video separation, and input checks passed.')

# Video search remains usable when the music catalog is unavailable.
from tempfile import TemporaryDirectory
from unittest.mock import patch
with TemporaryDirectory() as directory, patch('backend.CACHE', Path(directory)), patch('backend.monochrome.search', side_effect=AssertionError('Video search contacted the music catalog')), patch('backend.youtube_search', return_value=[{'id': 'youtube:abcdefghijk', 'source': 'youtube', 'kind': 'video'}]):
    assert dispatch('videos', {'query': 'Artist official music video'})['tracks'][0]['source'] == 'youtube'
print('YouTube video search is independent of the Monochrome catalog.')

with TemporaryDirectory() as directory, patch('backend.CACHE', Path(directory)), patch('backend.monochrome.home_artist') as lookup:
    lookup.side_effect = lambda seed: {'name': seed['name'], 'tracks': [{'id': 'heard'}, {'id': seed['name']}], 'related': []}
    assert dispatch('home', {}) == {'sections': []}
    assert lookup.call_count == 0
    home = dispatch('home', {'artists': [{'name': 'Sade'}, {'name': 'Björk'}], 'recent': ['heard']})
    assert [section['artist'] for section in home['sections']] == ['Sade', 'Björk']
    assert [song['id'] for section in home['sections'] for song in section['tracks']] == ['Sade', 'Björk']
    assert lookup.call_count == 2
print('Home uses the supplied listening artists and removes already heard tracks.')

seed = {'title': normalized['title'], 'artist': normalized['artist']}
def match_import():
    return dispatch('match', {'tracks': [seed]})['matches'][0]

# The old cache could contain a false miss. A plain retry after reconnection must
# find the song even after upgrading with that old cache entry still on disk.
with TemporaryDirectory() as directory, patch('backend.CACHE', Path(directory)):
    cached('recording-match-v2', seed, lambda: {'track': None, 'candidates': []})
    with patch('backend.monochrome.search', side_effect=[ValueError('offline'), {'tracks': [normalized]}]) as primary, \
         patch('backend.youtube_info', side_effect=ValueError('offline')) as fallback:
        assert match_import()['error'] is True
        assert match_import()['track'] == normalized
        assert match_import()['track'] == normalized
        assert primary.call_count == 2 and fallback.call_count == 1

# Keep partial candidates available for manual review, but do not save a miss
# until both catalogs have answered.
other = {**normalized, 'title': 'An alternative recording'}
with TemporaryDirectory() as directory, patch('backend.CACHE', Path(directory)), \
     patch('backend.monochrome.search', return_value={'tracks': [other]}) as primary, \
     patch('backend.youtube_info', side_effect=[ValueError('offline'), {'entries': []}]) as fallback:
    partial = match_import()
    assert partial['error'] and partial['candidates'] == [other]
    complete = match_import()
    assert not complete.get('error') and complete['candidates'] == [other] and complete['track'] is None
    assert match_import() == complete
    assert primary.call_count == fallback.call_count == 2

with TemporaryDirectory() as directory, patch('backend.CACHE', Path(directory)), \
     patch('backend.monochrome.search', side_effect=[ValueError('offline'), {'tracks': [normalized]}]), \
     patch('backend.youtube_info', return_value={'entries': []}):
    assert match_import()['error'] is True
    assert match_import()['track'] == normalized

youtube_song = {**normalized, 'id': 'youtube:abcdefghijk', 'source': 'youtube', 'remoteId': 'abcdefghijk'}
with TemporaryDirectory() as directory, patch('backend.CACHE', Path(directory)), \
     patch('backend.monochrome.search', side_effect=ValueError('offline')), \
     patch('backend.youtube_search', return_value=[youtube_song]):
    recovered = match_import()
    assert recovered['track'] == youtube_song and not recovered.get('error')
print('Spotify retries incomplete catalog lookups and caches completed matches and misses.')

# Bulk calls preserve positional results and avoid sending unused candidate
# metadata across the Android bridge. The manual lookup still gets the list.
with TemporaryDirectory() as directory, patch('backend.CACHE', Path(directory)), \
     patch('backend.match_recording', return_value={'track': normalized, 'candidates': [normalized]}) as lookup:
    bulk = dispatch('match', {'tracks': [seed, seed], 'includeCandidates': False})['matches']
    assert bulk == [{'track': normalized, 'reason': '', 'error': False}] * 2 and lookup.call_count == 1
    for i in range(230):
        dispatch('match', {'tracks': [{'title': 'Other ' + str(i), 'artist': 'Test'}]})
    assert match_import()['candidates'] == [normalized] and lookup.call_count == 231

with TemporaryDirectory() as directory, patch('backend.CACHE', Path(directory)), \
     patch('backend.youtube_info', return_value={'entries': [
         {'id': 'abcdefghijk', 'title': 'Song', 'channel': 'Artist - Topic', 'duration': 120},
         {'id': 'abcdefghijl', 'title': 'Song', 'duration': 120},
     ]}), patch('requests.get') as oembed:
    oembed.return_value.json.return_value = {'title': 'Song', 'author_name': 'Other Artist'}
    fallback = youtube_search('Artist Song', [], 'song', report_errors=True)
    assert [t['artist'] for t in fallback] == ['Artist', 'Other Artist']
    assert oembed.call_count == 1

# Cold matches in consecutive batches reuse at most two catalog connections.
# The catalog sets a cookie on every response. Later queries must never send it.
class CatalogHandler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def do_GET(self):
        self.server.received.append((self.client_address[1], self.headers.get('Cookie')))
        self.send_response(200)
        self.send_header('Content-Length', '2')
        self.send_header('Set-Cookie', 'catalog=abc; Path=/')
        self.end_headers()
        self.wfile.write(b'{}')

    def log_message(self, *args):
        pass

def lookup_local(seed):
    request('/search', q=seed['title'])
    return {'track': {'title': seed['title']}}

with ThreadingHTTPServer(('127.0.0.1', 0), CatalogHandler) as server:
    server.received = []
    serving = threading.Thread(target=server.serve_forever)
    serving.start()
    try:
        with TemporaryDirectory() as directory, patch('backend.CACHE', Path(directory)), \
             patch('backend.monochrome.BASE', f'http://127.0.0.1:{server.server_port}'), \
             patch.dict('os.environ', {'NO_PROXY': '127.0.0.1'}), \
             patch('backend.match_recording', side_effect=lookup_local):
            for i in range(3):
                inputs = [{'title': str(index)} for index in range(4 * i, 4 * i + 4)]
                assert [r['track'] for r in dispatch('match', {'tracks': inputs})['matches']] == inputs
        assert len(server.received) == 12
        assert len({port for port, _ in server.received}) <= 4
        assert all(cookie is None for _, cookie in server.received)
    finally:
        server.shutdown()
        serving.join()

with TemporaryDirectory() as folder, patch.object(backend, 'CACHE', Path(folder)):
    first = {'id': 'first-candidate'}
    second = {'id': 'second-candidate'}
    with patch.object(backend, 'match_recording', return_value={'track': None, 'candidates': [first, second]}):
        seed = {'title': 'Test title', 'artist': 'Test artist'}
        manual = backend.dispatch('match', {'tracks': [seed]})['matches'][0]
        automatic = backend.dispatch('match', {'tracks': [seed], 'includeCandidates': False})['matches'][0]
        assert manual['track'] is None and manual['candidates'][0] == automatic['track'] == first
