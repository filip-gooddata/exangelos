import json
import struct
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from test_direct import fixture, encode, uint, SELECTION


def framed(data):
    from ccl_simplesnappy.ccl_simplesnappy import crc32c
    crc = crc32c(b'\x01' + data)
    masked = (((crc >> 15) | (crc << 17)) + 0xa282ead8) & 0xffffffff
    return struct.pack('<IHB', masked, len(data), 1) + data


def database(root, state=None, sequence=10):
    folder = root / 'https_app.slack.com_0.indexeddb.leveldb'
    folder.mkdir(exist_ok=True)
    (folder / 'CURRENT').write_bytes(b'MANIFEST-000001\n')
    (folder / 'MANIFEST-000001').write_bytes(framed(b'\x02\x02'))
    blob = b'\xff\x12\xff\x10' + encode(state or fixture())
    path = root / 'https_app.slack.com_0.indexeddb.blob/1/00'
    path.mkdir(parents=True, exist_ok=True)
    (path / '1').write_bytes(blob)
    name = 'persist:slack-fixture-' + '-'.join(SELECTION[:2])
    suffix = b'\x01' + uint(len(name)) + name.encode('utf-16-be')
    rows = [(b'\x00\x01\x00\x00\x01', 'reduxPersistence'.encode('utf-16-be')),
            (b'\x00\x01\x00\x00\x32\x01\x00', 'reduxPersistenceStore'.encode('utf-16-be')),
            (b'\x00\x01\x01\x01' + suffix, b'\x00\xff\x11\x01' + uint(len(blob)) + b'\x00'),
            (b'\x00\x01\x01\x03' + suffix, b'\x00\x01\x00' + uint(len(blob)))]
    data = struct.pack('<QI', sequence, len(rows))
    data += b''.join(b'\x01' + uint(len(k)) + k + uint(len(v)) + v for k, v in rows)
    (folder / '000002.log').write_bytes(framed(data))


def request(root):
    return {'selection': {'workspace': SELECTION[0], 'owner': SELECTION[1], 'conversations': [SELECTION[2]]}, 'key': 'ab' * 32, 'root': str(root)}


class SourceTests(unittest.TestCase):
    def invoke(self, value):
        return subprocess.run([sys.executable, str(Path(__file__).with_name('source.py'))], input=json.dumps(value), text=True, capture_output=True)

    def test_real_decoder_command_emits_stable_keyed_snapshot_with_partial_reactions(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            state = fixture()
            state['reactions'] = {}
            database(root, state)
            first = self.invoke(request(root))
            self.assertEqual(first.returncode, 0, first.stderr)
            snap = json.loads(first.stdout)
            self.assertTrue(snap['complete'])
            self.assertFalse(snap['messages'][0]['reactionsComplete'])
            self.assertEqual(snap['generation'], '13')
            self.assertEqual(first.stdout, self.invoke(request(root)).stdout)
            self.assertEqual(first.stderr, '')
            for raw in (*SELECTION, 'fixture body', str(root), 'ab' * 32):
                self.assertNotIn(raw, first.stdout)

    def test_root_thread_markers_distinguish_absence_from_opaque_values(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            for marker, accepted in ((None, True), (b'_', True), (b'^\x00', False), (123, False), ('', False)):
                with self.subTest(accepted=accepted):
                    state = fixture()
                    next(iter(state['messages'][SELECTION[2]].values()))['thread_ts'] = marker
                    database(root, state)
                    result = self.invoke(request(root))
                    self.assertEqual(result.returncode, 0 if accepted else 1)
                    if accepted:
                        self.assertFalse(json.loads(result.stdout)['messages'][0]['reply'])
                    else:
                        self.assertEqual(result.stdout, '')
                        self.assertEqual(result.stderr, 'Slack persisted source unavailable.\n')

    def test_generation_and_snapshot_have_distinct_meanings(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            database(root, sequence=20)
            first = json.loads(self.invoke(request(root)).stdout)
            database(root, sequence=10)
            older = json.loads(self.invoke(request(root)).stdout)
            self.assertLess(int(older['generation']), int(first['generation']))
            self.assertEqual(older['snapshot'], first['snapshot'])
            changed = fixture()
            changed['messages'][SELECTION[2]][next(iter(changed['messages'][SELECTION[2]]))]['text'] = 'synthetic edit'
            database(root, changed, sequence=30)
            newer = json.loads(self.invoke(request(root)).stdout)
            self.assertEqual(first['scope'], newer['scope'])
            self.assertNotEqual(first['snapshot'], newer['snapshot'])

    def test_failure_is_fixed_and_never_partial_output(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            for fault in ('selection', 'key', 'hidden', 'body', 'thread', 'timestamp', 'checksum', 'missing_log', 'symlink'):
                with self.subTest(fault=fault):
                    state = fixture()
                    message = next(iter(state['messages'][SELECTION[2]].values()))
                    if fault == 'hidden': message['_hidden_stub'] = True
                    if fault == 'body': del message['text']
                    if fault == 'thread': message['thread_ts'] = 123
                    if fault == 'timestamp':
                        state['messages'][SELECTION[2]] = {'invalid-timestamp': message}
                    database(root, state)
                    value = request(root)
                    if fault == 'selection': value['selection']['conversations'] = ['C9999999']
                    if fault == 'key': value['key'] = 'private-invalid-value'
                    log = root / 'https_app.slack.com_0.indexeddb.leveldb/000002.log'
                    if fault == 'checksum': log.write_bytes(log.read_bytes()[:-1] + b'x')
                    if fault == 'missing_log': log.unlink()
                    if fault == 'symlink':
                        log.unlink()
                        log.symlink_to(root / 'absent')
                    result = self.invoke(value)
                    self.assertEqual(result.returncode, 1)
                    self.assertEqual(result.stdout, '')
                    self.assertEqual(result.stderr, 'Slack persisted source unavailable.\n')

    def test_full_scan_mutation_rejected(self):
        import source
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            database(root)
            original = source.scan.run
            def mutate(*args, **kwargs):
                result = original(*args, **kwargs)
                (root / 'https_app.slack.com_0.indexeddb.blob/1/00/1').write_bytes(b'changed')
                return result
            with patch.object(source.scan, 'run', side_effect=mutate):
                with self.assertRaisesRegex(ValueError, 'mutation'):
                    source.acquire(request(root))

    def test_selection_order_and_database_epoch(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            state = fixture()
            state['messages']['C0000002'] = {}
            database(root, state)
            value = request(root)
            value['selection']['conversations'].append('C0000002')
            first = json.loads(self.invoke(value).stdout)
            value['selection']['conversations'].reverse()
            self.assertEqual(first, json.loads(self.invoke(value).stdout))
            value['selection']['conversations'].pop()
            narrowed = json.loads(self.invoke(value).stdout)
            self.assertNotEqual(first['scope'], narrowed['scope'])
            folder = root / 'https_app.slack.com_0.indexeddb.leveldb'
            folder.rename(root / 'retired')
            database(root, state)
            replaced = json.loads(self.invoke(value).stdout)
            self.assertNotEqual(narrowed['scope'], replaced['scope'])

    def test_ambiguous_latest_record_fails(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            database(root)
            folder = root / 'https_app.slack.com_0.indexeddb.leveldb'
            data = bytearray((folder / '000002.log').read_bytes()[7:])
            data[-1] ^= 1
            (folder / '000003.log').write_bytes(framed(data))
            result = self.invoke(request(root))
            self.assertEqual(result.returncode, 1)
            self.assertEqual(result.stdout, '')

    def test_inline_record_cannot_hide_competing_persisted_generation(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            database(root)
            name = 'persist:slack-second-' + '-'.join(SELECTION[:2])
            key = b'\x00\x01\x01\x01\x01' + uint(len(name)) + name.encode('utf-16-be')
            value = b'\x00\xff\x12\xff\x10' + encode(fixture())
            batch = struct.pack('<QI', 50, 1) + b'\x01' + uint(len(key)) + key + uint(len(value)) + value
            (root / 'https_app.slack.com_0.indexeddb.leveldb/000003.log').write_bytes(framed(batch))
            result = self.invoke(request(root))
            self.assertEqual(result.returncode, 1)
            self.assertEqual(result.stdout, '')
            self.assertEqual(result.stderr, 'Slack persisted source unavailable.\n')
