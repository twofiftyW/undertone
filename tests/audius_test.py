"""Offline checks for searching and playing public Audius recordings."""
from pathlib import Path
import sys
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'music'))
import android_bridge
import audius
import backend


def public_song(ident='XQv19', **changes):
    return {'id': ident, 'title': 'The recording', 'user': {'name': 'The artist'},
            'is_streamable': True, 'is_stream_gated': False, 'access': {'stream': True},
            'duration': 321, 'permalink': '/artist/the-recording',
            'stream': {'url': 'https://example.invalid/short-lived-url'}, **changes}


class AudiusSearchTest(unittest.TestCase):
    @patch('audius.requests.get')
    def test_order_identity_and_metadata(self, get):
        first = public_song('pQ0', artwork={'480x480': 'https://example.org/cover'},
                            parental_warning_type='Explicit', album_backlink={'playlist_name': 'Album'})
        second = public_song('r01', parental_warning_type='ExplicitContentEdited')
        get.return_value.json.return_value = {'data': [first, second, first]}
        result = android_bridge.dispatch('music', {'operation': 'audius_search', 'args': {'query': '  The artist  '}})
        self.assertEqual([s['id'] for s in result['tracks']], ['audius:pQ0', 'audius:r01'])
        a, b = result['tracks']
        self.assertEqual((a['title'], a['artist'], a['duration']), ('The recording', 'The artist', 321))
        self.assertEqual(a['artists'], [{'id': '', 'name': 'The artist'}])
        self.assertEqual(a['album'], {'id': '', 'title': 'Album'})
        self.assertEqual(a['artwork'], 'https://example.org/cover')
        self.assertEqual(a['permalink'], 'https://audius.co/artist/the-recording')
        self.assertTrue(a['explicit'])
        self.assertFalse(b['explicit'])
        self.assertNotIn('stream', a)
        self.assertEqual(get.call_args.kwargs['params']['query'], 'The artist')
        playback = android_bridge.dispatch('resolve_track', {'track': a})
        self.assertEqual(playback['url'], 'https://discoveryprovider.audius.co/v1/tracks/pQ0/stream?app_name=UndertonePersonal')
        self.assertEqual(android_bridge.dispatch('resolve_track', {'track': a, 'offlineOnly': True}), {'url': None})

    def test_only_public_playable_tracks(self):
        for change in [
            {'is_delete': True}, {'is_unlisted': True}, {'is_available': False}, {'is_streamable': False},
            {'is_stream_gated': True}, {'access': {'stream': False}}, {'allowed_api_keys': ['key']},
            {'stream_conditions': {'usdc_purchase': {'price': 99}}}, {'id': '../bad'}, {'title': ''},
        ]:
            with self.subTest(change=change):
                self.assertIsNone(audius.track(public_song(**change)))
        self.assertFalse(audius.track(public_song())['explicit'])
        self.assertEqual(audius.track(public_song(permalink='//bad.example/artist/title'))['permalink'], '')
        self.assertIsNone(audius.track(None))

    @patch('audius.requests.get')
    def test_empty_search_and_failures(self, get):
        self.assertEqual(backend.dispatch('audius_search', {'query': ' '}), {'tracks': []})
        get.assert_not_called()
        get.side_effect = audius.requests.ConnectionError()
        with self.assertRaisesRegex(ValueError, 'connection'):
            audius.search('demo')
        get.side_effect = None
        get.return_value = Mock(status_code=429)
        with self.assertRaisesRegex(ValueError, 'busy'):
            audius.search('demo')
        get.return_value = Mock(status_code=200)
        get.return_value.json.return_value = {'data': {}}
        with self.assertRaises(ValueError):
            audius.search('demo')


if __name__ == '__main__':
    unittest.main()
