"""Exercise the packaged desktop command/worker contract with an offline catalog."""
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest

MUSIC = Path(__file__).resolve().parents[1] / 'music'


class DesktopSpotifyTest(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.root = Path(folder.name)
        runtime = self.root / 'music'
        runtime.mkdir()
        for name in ('desktop_spotify.py', 'spotify_job.py'):
            shutil.copyfile(MUSIC / name, runtime / name)
        (runtime / 'backend.py').write_text("""
import os, time
from pathlib import Path
def dispatch(operation, args):
    root = Path(os.environ['TEST_JOB_ROOT'])
    (root / 'entered').write_text(str(os.getpid()))
    for _ in range(300):
        if not (root / 'hold').exists():
            break
        time.sleep(.05)
    else:
        return {'matches': [{'error': True} for row in args['tracks']]}
    with (root / 'lookups').open('a') as log:
        for row in args['tracks']:
            print(row['title'], file=log)
    return {'matches': [{'track': {'id': 'mono:' + row['title']}} for row in args['tracks']]}
""", encoding='utf-8')
        (runtime / 'desktop_import_notification.py').write_text("""
import os
from pathlib import Path
def notify_import(state):
    with (Path(os.environ['TEST_JOB_ROOT']) / 'notifications').open('a') as log:
        print(state['state'], file=log)
""", encoding='utf-8')
        self.cli = [sys.executable, '-X', 'utf8', '-B', str(runtime / 'desktop_spotify.py'), str(self.root)]
        self.env = dict(os.environ, TEST_JOB_ROOT=str(self.root))
        self.ids = [f'track{i}' for i in range(12)]
        self.library = json.dumps({
            'tracks': {i: {'source': 'unmatched', 'importRecord': {'title': i}} for i in self.ids},
            'playlists': [{'id': 'mix', 'trackIds': self.ids + [self.ids[0]]}]
        })
        (self.root / 'library.json').write_text(self.library, encoding='utf-8')
        self.hold = self.root / 'hold'
        self.hold.touch()
        self.controller = None

    def tearDown(self):
        self.hold.unlink(missing_ok=True)
        self.close_controller()
        # Allow the worker's optional notification to finish using the temporary directory.
        if (self.root / 'entered').exists():
            self.until(lambda: (self.root / 'notifications').is_file() or self.call('status')['state'] == 'paused')

    def open_controller(self):
        self.controller = subprocess.Popen(self.cli + ['--stdio'], stdin=subprocess.PIPE,
                                           stdout=subprocess.PIPE, text=True, encoding='utf-8', env=self.env)

    def close_controller(self):
        if self.controller:
            self.controller.stdin.close()
            self.assertEqual(self.controller.wait(timeout=5), 0)
            self.controller.stdout.close()
            self.controller = None

    def call(self, name, **parameters):
        request = json.dumps({'operation': 'spotify_job_' + name, 'args': parameters})
        if self.controller:
            self.controller.stdin.write(request + '\n')
            self.controller.stdin.flush()
            reply = self.controller.stdout.readline()
        else:
            reply = subprocess.check_output(self.cli, input=request, text=True, encoding='utf-8',
                                              env=self.env, timeout=8)
        result = json.loads(reply)
        self.assertNotIn('error', result)
        return result['data']

    def until(self, check):
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            if check():
                return
            time.sleep(.05)
        self.fail('Timed out waiting for detached worker')

    def test_closing_app_and_pausing_in_flight(self):
        self.open_controller()
        job = self.call('start', playlistId='mix')
        ident = job['jobId']
        self.assertTrue(job['serviceActive'])
        self.assertEqual(job['total'], len(self.ids))
        self.until(lambda: (self.root / 'entered').exists())
        self.close_controller()
        self.open_controller()
        self.assertTrue(self.call('status')['serviceActive'])
        self.assertEqual(self.call('start', playlistId='mix')['total'], len(self.ids))
        self.assertEqual(self.call('pause', jobId=ident)['state'], 'paused')
        self.hold.unlink()
        self.until(lambda: not self.call('status')['serviceActive'])
        self.assertEqual(self.call('status')['checked'], 4)
        self.call('resume', jobId=ident)
        self.close_controller()
        self.until(lambda: self.call('status')['state'] == 'done')
        self.assertEqual([r['id'] for r in self.call('results', jobId=ident)['items']], self.ids)
        self.assertEqual(self.call('ack', jobId=ident, through=12)['pending'], 0)
        self.assertEqual((self.root / 'lookups').read_text().splitlines(), self.ids)
        self.assertEqual((self.root / 'library.json').read_text(encoding='utf-8'), self.library)

    def test_explicit_resume_after_worker_was_killed(self):
        self.open_controller()
        job = self.call('start', playlistId='mix')
        marker = self.root / 'entered'
        self.until(lambda: marker.exists() and marker.stat().st_size > 0)
        os.kill(int(marker.read_text()), signal.SIGTERM)
        self.until(lambda: not self.call('status')['serviceActive'])
        self.assertEqual(self.call('status')['state'], 'running')
        self.hold.unlink()
        self.assertEqual(self.call('resume', jobId=job['jobId'])['jobId'], job['jobId'])
        self.until(lambda: self.call('status')['state'] == 'done')
        self.assertEqual(self.call('status')['pending'], 12)
        self.assertEqual((self.root / 'lookups').read_text().splitlines(), self.ids)


if __name__ == '__main__':
    unittest.main()
