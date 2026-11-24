"""LRCLIB response handling and offline lookup through the shipped music bridge."""
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import MagicMock, patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'music'))
import android_bridge
import backend
import lyrics


def response(status=200, record=None):
    mock = MagicMock(status_code=status, headers={})
    mock.__enter__.return_value = mock
    mock.iter_content.return_value = [json.dumps(record).encode()]
    return mock


class LyricsTest(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.root = Path(self.folder.name)
        self.directory = self.root / 'lyrics'
        env = patch.dict(os.environ, {'UNDERTONE_DOWNLOAD_DIR': str(self.root / 'downloads')})
        env.start()
        self.addCleanup(env.stop)
        self.args = {'title': 'Song', 'artist': 'Артист', 'album': 'Album', 'duration': 201.4, 'key': '../track'}
        self.plain = {'plainLyrics': 'First line', 'syncedLyrics': None, 'instrumental': False}

    def lookup(self, **args):
        return backend.dispatch('lyrics', {**self.args, **args})

    def test_only_fetch_on_request_and_find_by_stable_key_in_mobile_bridge(self):
        record = {**self.plain, 'syncedLyrics': '[00:02.10] First line'}
        with patch('lyrics.requests.get', return_value=response(record=record)) as get:
            self.assertIsNone(self.lookup(cacheOnly=True))
            get.assert_not_called()
            self.assertFalse(self.directory.exists())
            self.assertEqual(self.lookup(), record)
            get.assert_called_once()
            self.assertEqual(get.call_args.args, ('https://lrclib.net/api/get',))
            self.assertEqual(get.call_args.kwargs['params'],
                             {'track_name': 'Song', 'artist_name': 'Артист', 'album_name': 'Album', 'duration': 201})
            self.assertIn('Undertone', get.call_args.kwargs['headers']['User-Agent'])
        self.assertEqual(len(list(self.directory.glob('*.json'))), 1)
        with patch('lyrics.requests.get', side_effect=AssertionError('unexpected network access')):
            for only in (True, False):
                request = {'operation': 'lyrics', 'args': {'key': '../track', 'cacheOnly': only}}
                self.assertEqual(android_bridge.dispatch('music', request), record)

    def test_plain_and_instrumental_results_persist(self):
        instrumental = {'plainLyrics': None, 'syncedLyrics': None, 'instrumental': True}
        for key, record in [('plain', self.plain), ('instrumental', instrumental)]:
            replies = [response(record=record)] if record['instrumental'] else [response(record=record), response(record=[])]
            with patch('lyrics.requests.get', side_effect=replies) as get:
                self.assertEqual(self.lookup(key=key, album='', duration=0), record)
                self.assertEqual(set(get.call_args.kwargs['params']), {'track_name', 'artist_name'})
                self.assertEqual(self.lookup(key=key, cacheOnly=True), record)

    def test_missing_and_transient_errors_can_retry(self):
        with patch('lyrics.requests.get', side_effect=[
            response(404), response(record=[]), lyrics.requests.ConnectionError(), response(record=self.plain), response(record=[])
        ]):
            self.assertIsNone(self.lookup())
            with self.assertRaises(ValueError):
                self.lookup()
            self.assertIsNone(self.lookup(cacheOnly=True))
            self.assertEqual(self.lookup(), self.plain)

    def test_invalid_or_oversize_responses_never_populate_cache(self):
        too_large = response()
        too_large.iter_content.return_value = [b'x' * 32768] * (lyrics.MAX_RESPONSE // 32768 + 1)
        big_lyrics = response(record={**self.plain, 'plainLyrics': 'a' * lyrics.MAX_BRIDGE_BYTES})
        for reply in (response(record={'message': 'invalid'}), too_large, big_lyrics):
            with patch('lyrics.requests.get', return_value=reply), self.assertRaises(ValueError):
                self.lookup()
            self.assertIsNone(self.lookup(cacheOnly=True))

    def test_slow_response_can_retry(self):
        with patch('lyrics.requests.get', return_value=response(record=self.plain)), \
             patch('lyrics.time.monotonic', side_effect=[100, 121]), self.assertRaises(ValueError):
            self.lookup()
        self.assertIsNone(self.lookup(cacheOnly=True))

    def test_retry_after_survives_subsequent_requests(self):
        busy = response(429)
        busy.headers = {'Retry-After': '20'}
        with patch('lyrics.requests.get', return_value=busy) as get, patch('lyrics.time.time', return_value=100):
            with self.assertRaises(ValueError):
                self.lookup()
            with self.assertRaises(ValueError):
                self.lookup(key='another recording')
            self.assertEqual(get.call_count, 1)
        with patch('lyrics.requests.get', return_value=response(404)), patch('lyrics.time.time', return_value=121):
            self.assertIsNone(self.lookup())

    def test_storage_failure_does_not_hide_fetched_lyrics(self):
        self.directory.write_text('not a directory')
        with patch('lyrics.requests.get', return_value=response(record=self.plain)):
            self.assertEqual(self.lookup(), {**self.plain, 'storageFailed': True})
            self.assertIsNone(self.lookup(cacheOnly=True))

    def test_concurrent_writes_leave_one_readable_record(self):
        with patch('lyrics.fetch', side_effect=lambda *_: (dict(self.plain), True)):
            with ThreadPoolExecutor(max_workers=4) as workers:
                self.assertEqual(list(workers.map(lambda _: self.lookup(), range(12))), [self.plain] * 12)
        self.assertEqual(self.lookup(cacheOnly=True), self.plain)
        self.assertEqual(len(list(self.directory.iterdir())), 1)

    def test_prefers_timed_copy_of_the_same_recording(self):
        timed = {**self.plain, 'syncedLyrics': '[00:03.00] First line'}
        candidate = {**timed, 'trackName': 'Song', 'artistName': 'АРТИСТ', 'albumName': 'Album', 'duration': 201}
        false_matches = [
            {**candidate, 'artistName': 'Another singer'},
            {**candidate, 'trackName': 'Another track', 'albumName': 'Song'},
            {**candidate, 'trackName': 'Song (Remix)'},
            {**candidate, 'duration': 213},
            {**candidate, 'plainLyrics': 'Unrelated words from a different recording'},
            {**candidate, 'syncedLyrics': '[00:01.00]\n[00:12.00]'},
        ]
        self.assertIsNone(lyrics.select_record(false_matches, {
            'track_name': 'Song', 'artist_name': 'Артист', 'duration': 201, 'album_name': 'Album',
        }, self.plain, {}))
        with patch('lyrics.requests.get', side_effect=[response(record=self.plain), response(record=false_matches + [candidate])]) as get:
            self.assertEqual(self.lookup(), timed)
            self.assertEqual(get.call_args.args[0], lyrics.SEARCH_ENDPOINT)
            self.assertEqual(get.call_args.kwargs['params'], {'track_name': 'Song', 'artist_name': 'Артист'})
        with patch('lyrics.requests.get', side_effect=AssertionError('cached timed result contacted provider')):
            self.assertEqual(self.lookup(), timed)

    def test_feature_credit_can_move_between_title_and_artist(self):
        timed = {**self.plain, 'syncedLyrics': '[00:03.00] First line'}
        candidate = {**timed, 'trackName': 'Song (feat. Guest)', 'artistName': 'Артист', 'duration': 202, 'albumName': 'Album'}
        with patch('lyrics.requests.get', side_effect=[response(404), response(record=[candidate])]):
            self.assertEqual(self.lookup(artist='Артист, Guest'), timed)
        with patch('lyrics.requests.get', side_effect=[response(404), response(record=[candidate])]):
            self.assertIsNone(self.lookup(artist='Артист, Different guest', key='different'))

    def test_plain_search_fallback_and_bracketed_synchronized_words(self):
        candidate = {**self.plain, 'trackName': 'Song', 'artistName': 'Артист', 'duration': 201, 'albumName': 'Album'}
        with patch('lyrics.requests.get', side_effect=[response(404), response(record=[candidate])]):
            self.assertEqual(self.lookup(), self.plain)
        self.assertFalse(lyrics.has_timing('[ar:Name]\n[00:01.20][00:03.50] \n[00:20.10]<00:21.10>'))
        self.assertTrue(lyrics.has_timing('[00:01.20][00:03.50] [Intro]'))

    def test_upgrades_old_plain_without_blocking_offline_and_rechecks_periodically(self):
        self.directory.mkdir()
        key = hashlib.sha256(self.args['key'].encode()).hexdigest()
        legacy = self.directory / (key + '.json')
        legacy.write_text(json.dumps(self.plain))
        with patch('lyrics.requests.get', side_effect=AssertionError('cached words must display immediately')):
            self.assertEqual(self.lookup(cacheOnly=True), self.plain)
            self.assertEqual(self.lookup(), {**self.plain, 'refreshSync': True})
        with patch('lyrics.requests.get', side_effect=lyrics.requests.ConnectionError()), patch('lyrics.time.time', return_value=100):
            self.assertEqual(self.lookup(refreshSync=True), self.plain)
        with patch('lyrics.time.time', return_value=101):
            self.assertEqual(self.lookup(), self.plain)
        timed = {**self.plain, 'syncedLyrics': '[00:03.00] First line'}
        candidate = {**timed, 'trackName': 'Song', 'artistName': 'Артист', 'duration': 202, 'albumName': 'Album'}
        with patch('lyrics.requests.get', side_effect=[response(record=[])]), patch('lyrics.time.time', return_value=100 + lyrics.RETRY_RECHECK):
            self.assertEqual(self.lookup(refreshSync=True), self.plain)
        with patch('lyrics.time.time', return_value=101 + lyrics.RETRY_RECHECK):
            self.assertEqual(self.lookup(), self.plain)
        with patch('lyrics.requests.get', return_value=response(record=[candidate])) as get, patch('lyrics.time.time', return_value=101 + lyrics.SYNC_RECHECK + lyrics.RETRY_RECHECK):
            self.assertEqual(self.lookup(), {**self.plain, 'refreshSync': True})
            self.assertEqual(self.lookup(refreshSync=True), timed)
            get.assert_called_once()
        # A late plain writer finishing after this upgrade cannot replace it.
        legacy.write_text(json.dumps(self.plain))
        with patch('lyrics.requests.get', side_effect=AssertionError('upgraded copy should work offline')):
            self.assertEqual(self.lookup(cacheOnly=True), timed)


if __name__ == '__main__':
    unittest.main()
