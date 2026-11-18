"""Run the durable Android Spotify worker protocol offline, including an engine restart."""
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

MUSIC = Path(__file__).resolve().parents[1] / 'music'
sys.path.insert(0, str(MUSIC))
import android_bridge
import backend


class SpotifyJobTest(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.root = Path(folder.name)
        android_bridge.configure(self.root, self.root / 'cache')
        ids = list('abcdefghij')
        self.library = {
            'tracks': {ident: {'source': 'unmatched', 'spotifyMatchChecked': ident == 'j',
                               'importRecord': {'artist': 'Test', 'title': ident}} for ident in ids},
            'playlists': [{'id': 'first', 'trackIds': list('abacdef')},
                          {'id': 'other', 'trackIds': list('fbghij')}, {'id': 'review', 'trackIds': ['j']}]
        }
        self.library_file = self.root / 'library.json'
        self.library_file.write_text(json.dumps(self.library), encoding='utf-8')

    def call(self, command, **args):
        reply = json.loads(android_bridge.handle('spotify_job_' + command, json.dumps(args)))
        self.assertNotIn('error', reply, reply)
        return reply['data']

    def test_pause_append_save_ack_and_restart(self):
        job = self.call('start', playlistId='first', language='ru')
        self.assertEqual((job['total'], job['language'], job['playlistId']), (6, 'ru', 'first'))
        started, release = threading.Event(), threading.Event()
        looked_up = []

        def catalog(op, args):
            self.assertEqual(op, 'match')
            self.assertFalse(args['includeCandidates'])
            started.set()
            self.assertTrue(release.wait(5))
            names = [track['title'] for track in args['tracks']]
            looked_up.extend(names)
            return {'matches': [{'track': {'id': 'mono:' + name}} if name != 'd' else {'reason': 'Ambiguous'}
                                for name in names]}

        ident = job['jobId']
        with patch.object(backend, 'dispatch', side_effect=catalog), ThreadPoolExecutor(1) as executor:
            worker = executor.submit(self.call, 'step', jobId=ident)
            try:
                self.assertTrue(started.wait(5))
                self.assertEqual(self.call('start', playlistId='other')['total'], 9)
                self.assertEqual(self.call('start', playlistId='other')['total'], 9)
                self.assertEqual(self.call('pause', jobId=ident)['state'], 'paused')
            finally:
                release.set()
            paused = worker.result(timeout=5)
            self.assertEqual((paused['state'], paused['reason'], paused['checked'], paused['playlistId']),
                             ('paused', 'user', 4, ''))
            self.assertEqual(self.call('step', jobId=ident), paused)

            # A genuinely new interpreter sees the saved outbox before the UI saves/acknowledges.
            replay = subprocess.check_output([
                sys.executable, '-B', '-c',
                "import sys; sys.path.insert(0, sys.argv[1]); import android_bridge as a; "
                "a.configure(sys.argv[2],sys.argv[2]); print(a.handle('spotify_job_results',sys.argv[3]))",
                str(MUSIC), str(self.root), json.dumps({'jobId': ident})
            ], text=True)
            rows = json.loads(replay)['data']['items']
            self.assertEqual([row['id'] for row in rows], list('abcd'))
            self.assertEqual(rows[-1]['reason'], 'Ambiguous')
            self.assertEqual(self.call('results', jobId=ident, after=1, limit=2)['items'], rows[1:3])
            self.assertEqual(self.call('ack', jobId=ident, through=2)['pending'], 2)
            self.assertEqual(self.call('ack', jobId=ident, through=1)['pending'], 2)
            self.assertEqual(self.call('results', jobId=ident)['items'], rows[2:])

            self.assertEqual(self.call('resume', jobId=ident)['state'], 'running')
            self.call('step', jobId=ident)
            done = self.call('step', jobId=ident)
            self.assertEqual((done['state'], done['total'], done['checked'], done['pending']), ('done', 9, 9, 7))
            # Another selection can extend a completed job whose existing results await application.
            extended = self.call('start', playlistId='review', retryMisses=True)
            self.assertEqual((extended['state'], extended['jobId'], extended['total']), ('running', ident, 10))
            self.assertEqual(self.call('step', jobId=ident)['state'], 'done')
            self.assertEqual(looked_up, list('abcdefghij'))
            self.assertEqual(self.call('ack', jobId=ident, through=10)['pending'], 0)

            new_job = self.call('start', playlistId='review', retryMisses=True)
            self.assertNotEqual(new_job['jobId'], ident)
            self.assertEqual(self.call('pause', jobId=ident), new_job)
            self.assertEqual(self.call('results', jobId=ident)['items'], [])
        self.assertEqual(json.loads(self.library_file.read_text(encoding='utf-8')), self.library)

    def test_network_failures_remain_retryable(self):
        job = self.call('start', playlistId='first')
        ident = job['jobId']
        checked = []

        def sometimes_offline(op, args):
            names = [row['title'] for row in args['tracks']]
            checked.append(names)
            return {'matches': [{'error': True} if i == 'a' else {'reason': 'No match'} for i in names]}

        with patch.object(backend, 'dispatch', side_effect=sometimes_offline):
            first = self.call('step', jobId=ident)
            self.assertEqual((first['checked'], first['state']), (3, 'running'))
            second = self.call('step', jobId=ident)
            self.assertEqual((second['checked'], second['state'], second['reason']), (5, 'paused', 'offline'))
            self.call('resume', jobId=ident)
            self.assertEqual(self.call('step', jobId=ident)['state'], 'paused')
            self.assertEqual(checked, [list('abcd'), list('ef'), ['a']])
        with patch.object(backend, 'dispatch', return_value={'matches': [{'track': {'id': 'mono:a'}}]}):
            self.call('resume', jobId=ident)
            self.assertEqual(self.call('step', jobId=ident)['checked'], 6)
        rows = self.call('results', jobId=ident)['items']
        self.assertEqual([row['id'] for row in rows], list('bcdefa'))
        self.assertEqual([row['seq'] for row in rows], list(range(1, 7)))


if __name__ == '__main__':
    unittest.main()
