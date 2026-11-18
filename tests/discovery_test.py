"""Exercise Undertone discovery and pairing on loopback without accessing the LAN."""
from contextlib import closing, contextmanager
import json
from pathlib import Path
import socket
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'music'))
import device_sync


@contextmanager
def sharing_pc(root, name='Studio', port=0):
    root.mkdir()
    library = {'version': 1, 'tracks': {}, 'playlists': [{'id': root.name}]}
    (root / 'library.json').write_text(json.dumps(library))
    with patch.object(socket, 'gethostname', return_value=name):
        server = device_sync.LibraryServer(root, '127.0.0.1', port)
    thread = threading.Thread(target=server.serve_forever, args=(0.02,), daemon=True)
    thread.start()
    try:
        yield server
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


class DiscoveryTest(unittest.TestCase):
    def test_pc_invites_only_the_selected_phone(self):
        with closing(device_sync.PhonePresence('Pixel', '127.0.0.1', 0)) as first, \
                closing(device_sync.PhonePresence('Pixel', '127.0.0.1', 0)) as second:
            targets = [first.server_address, second.server_address]
            phones = device_sync.discover_phones(targets=targets, timeout=0.3)
            by_address = {phone['address']: phone for phone in phones}
            first_address, second_address = [f'{ip}:{port}' for ip, port in targets]
            self.assertCountEqual(by_address, [first_address, second_address])
            self.assertEqual([phone['name'] for phone in phones], ['Pixel', 'Pixel'])
            self.assertNotEqual(by_address[first_address]['id'], by_address[second_address]['id'])
            self.assertIsNone(first.take_invitation())
            self.assertIsNone(second.take_invitation())
            selected = by_address[second_address]
            with patch.object(socket, 'gethostname', return_value='Studio'):
                self.assertTrue(device_sync.invite_phone(selected['address'], selected['id'], timeout=0.3))
            self.assertIsNone(first.take_invitation())
            self.assertEqual(second.take_invitation(), {'name': 'Studio', 'address': '127.0.0.1:47832'})
            self.assertIsNone(second.take_invitation())
        self.assertEqual(device_sync.discover_phones(targets=targets, timeout=0.15), [])

    def test_closed_and_replaced_phone_rejects_stale_invite(self):
        with closing(device_sync.PhonePresence('Original', '127.0.0.1', 0)) as original:
            target = original.server_address
            old, = device_sync.discover_phones(targets=[target], timeout=0.2)
        with self.assertRaises(ValueError):
            device_sync.invite_phone(old['address'], old['id'], timeout=0.15)
        with closing(device_sync.PhonePresence('Replacement', *target)) as replacement:
            fresh, = device_sync.discover_phones(targets=[target], timeout=0.2)
            self.assertEqual(fresh['address'], old['address'])
            self.assertNotEqual(fresh['id'], old['id'])
            with self.assertRaises(ValueError):
                device_sync.invite_phone(old['address'], old['id'], timeout=0.15)
            self.assertIsNone(replacement.take_invitation())

    def test_retried_invitation_only_appears_once_and_expires(self):
        with closing(device_sync.PhonePresence('Pixel', '127.0.0.1', 0)) as phone, \
                socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as pc:
            target = phone.server_address
            found, = device_sync.discover_phones(targets=[target], timeout=0.2)
            instance = found['id'].encode()
            pc.settimeout(0.5)
            def send(nonce):
                pc.sendto(b'UNDERTONE/1 INVITE ' + instance + b' ' + nonce + b' Studio', target)
                self.assertEqual(pc.recvfrom(1024)[0], b'UNDERTONE/1 RECEIVED ' + instance + b' ' + nonce)

            send(b'a' * 32)
            send(b'a' * 32)
            self.assertEqual(phone.take_invitation()['name'], 'Studio')
            self.assertIsNone(phone.take_invitation())
            send(b'b' * 32)
            later = time.monotonic() + 31
            with patch.object(device_sync.time, 'monotonic', return_value=later):
                self.assertIsNone(phone.take_invitation())
            self.assertIsNone(phone.take_invitation())

    def test_choose_between_same_named_pcs_and_pair_with_selected_one(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            phone = root / 'phone'
            phone.mkdir()
            with sharing_pc(root / 'first') as first, sharing_pc(root / 'second') as second:
                targets = [first.server_address, second.server_address]
                devices = device_sync.discover(targets=targets, timeout=0.4)
                by_address = {pc['address']: pc for pc in devices}
                first_address, second_address = [f'{ip}:{port}' for ip, port in targets]
                self.assertCountEqual(devices, [
                    {'name': 'Studio', 'address': first_address},
                    {'name': 'Studio', 'address': second_address},
                ])
                self.assertFalse((phone / 'pc-link.json').exists())

                selected = by_address[second_address]['address']
                device_sync.pair(phone, selected, second.details()['code'])
                self.assertEqual(device_sync.pull(phone)['library']['playlists'], [{'id': 'second'}])
                self.assertEqual(len(first.devices['tokens']), 0)
                self.assertEqual(len(second.devices['tokens']), 1)

                # A failed switch must leave the existing paired PC usable.
                with self.assertRaisesRegex(ValueError, 'different PC'):
                    device_sync.pair(phone, first_address, second.details()['code'])
                self.assertEqual(device_sync.pull(phone)['deviceId'], second.devices['deviceId'])
            self.assertEqual(device_sync.discover(targets=targets, timeout=0.15), [])

    def test_discovery_replies_only_with_public_display_information(self):
        with tempfile.TemporaryDirectory() as temp, sharing_pc(Path(temp) / 'pc') as server:
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as client:
                client.settimeout(0.25)
                client.sendto(b'hello', server.server_address)
                with self.assertRaises(TimeoutError):
                    client.recvfrom(1024)
                nonce = b'a' * 32
                client.sendto(b'UNDERTONE/1 FIND ' + nonce, server.server_address)
                reply, sender = client.recvfrom(1024)
                self.assertEqual(sender, server.server_address)
                self.assertRegex(reply, rb'^UNDERTONE/1 PC ' + nonce + rb' [a-f0-9]{16} Studio\Z')
                self.assertEqual(server.attempts, 0)

    def test_discards_unrelated_stale_and_duplicate_replies(self):
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as responder:
            responder.bind(('127.0.0.1', 0))
            responder.settimeout(2)
            target = responder.getsockname()

            def reply():
                responder.recvfrom(1024)  # Drop the first probe to exercise retry.
                request, client = responder.recvfrom(1024)
                nonce = request.split()[-1]
                header = b'UNDERTONE/1 PC ' + nonce
                valid = header + b' ' + b'c' * 16 + b' Test PC'
                stale_nonce = (b'0' if nonce[:1] != b'0' else b'1') + nonce[1:]
                with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as unrelated_service:
                    unrelated_service.sendto(valid.replace(b'c' * 16 + b' Test PC', b'2' * 16 + b' Wrong port'), client)
                for packet in [
                    b'Other service', valid.replace(nonce, stale_nonce).replace(b'Test PC', b'Stale'),
                    header + b' invalid-identity Other', header + b' ' + b'1' * 16 + b' \xff',
                    valid, valid,
                ]:
                    responder.sendto(packet, client)

            thread = threading.Thread(target=reply, daemon=True)
            thread.start()
            devices = device_sync.discover(targets=[target], timeout=0.6)
            thread.join(timeout=1)
            self.assertEqual(devices, [{'name': 'Test PC', 'address': f'{target[0]}:{target[1]}'}])

    def test_manual_pairing_when_udp_port_is_in_use(self):
        with tempfile.TemporaryDirectory() as temp, socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as occupied:
            occupied.bind(('127.0.0.1', 0))
            target = occupied.getsockname()
            root = Path(temp)
            phone = root / 'phone'
            phone.mkdir()
            with sharing_pc(root / 'pc', port=target[1]) as server:
                self.assertFalse(server.details()['discoveryAvailable'])
                self.assertEqual(device_sync.discover(targets=[target], timeout=0.15), [])
                paired = device_sync.pair(phone, f'{target[0]}:{target[1]}', server.details()['code'])
                self.assertTrue(paired['paired'])


if __name__ == '__main__':
    unittest.main()
