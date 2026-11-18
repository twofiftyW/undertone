"""Offline catalog checks: no network requests or access to the private library."""
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'music'))
from backend import dispatch, track as video_track
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
