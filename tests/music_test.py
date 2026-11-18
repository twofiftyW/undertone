"""Offline catalog checks: no network requests or access to the private library."""
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'music'))
from backend import cached, dispatch, track as video_track
from monochrome import track, release, artist_card, identifier, unique

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
