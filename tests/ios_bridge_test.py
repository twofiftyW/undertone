import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / 'ios'), str(ROOT / 'music')]
from runtime import AppServer


class IosBridgeTest(unittest.TestCase):
    def test_library_and_audio_use_the_private_loopback_session(self):
        with tempfile.TemporaryDirectory() as scratch:
            root = Path(scratch)
            with AppServer(str(root / 'data'), str(root / 'cache'), ROOT / 'web', '0.1.0-beta') as server:
                thread = threading.Thread(target=server.serve_forever, daemon=True)
                thread.start()
                host = 'http://' + server.host

                def request(path, payload=None, headers=None):
                    body = json.dumps(payload).encode() if payload is not None else None
                    return urllib.request.urlopen(urllib.request.Request(host + server.prefix + path,
                        data=body, headers=headers or {}), timeout=5)

                try:
                    with request('index.html') as page:
                        self.assertIn(b'Settings', page.read())
                    with request('bridge/app_update', {'operation': 'status'}) as status:
                        self.assertEqual(json.load(status)['data']['version'], '0.1.0-beta')
                    library = {'version': 1, 'tracks': {}, 'playlists': []}
                    with request('bridge/save_library', {'library': library}) as reply:
                        self.assertTrue(json.load(reply)['data'])
                    with request('bridge/load_library', {}) as reply:
                        self.assertEqual(json.load(reply)['data'], library)
                    audio = '1' * 64 + '.wav'
                    (root / 'data' / 'audio' / audio).write_bytes(b'RIFFabcdefgh')
                    with request('audio/' + audio, headers={'Range': 'bytes=4-7'}) as part:
                        self.assertEqual(part.status, 206)
                        self.assertEqual(part.read(), b'abcd')
                    with self.assertRaises(urllib.error.HTTPError) as rejected:
                        urllib.request.urlopen(host + '/index.html', timeout=3)
                    self.assertEqual(rejected.exception.code, 404)
                finally:
                    server.shutdown()
                    thread.join()


if __name__ == '__main__':
    unittest.main()
