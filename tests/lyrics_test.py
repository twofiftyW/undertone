"""LRCLIB response handling and offline lookup through the shipped music bridge."""
from concurrent.futures import ThreadPoolExecutor
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
            with patch('lyrics.requests.get', return_value=response(record=record)) as get:
                self.assertEqual(self.lookup(key=key, album='', duration=0), record)
                self.assertEqual(set(get.call_args.kwargs['params']), {'track_name', 'artist_name'})
                self.assertEqual(self.lookup(key=key, cacheOnly=True), record)

    def test_missing_and_transient_errors_can_retry(self):
        with patch('lyrics.requests.get', side_effect=[
            response(404), lyrics.requests.ConnectionError(), response(record=self.plain)
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
        with patch('lyrics.fetch', side_effect=lambda *_: dict(self.plain)):
            with ThreadPoolExecutor(max_workers=4) as workers:
                self.assertEqual(list(workers.map(lambda _: self.lookup(), range(12))), [self.plain] * 12)
        self.assertEqual(self.lookup(cacheOnly=True), self.plain)
        self.assertEqual(len(list(self.directory.iterdir())), 1)


if __name__ == '__main__':
    unittest.main()
