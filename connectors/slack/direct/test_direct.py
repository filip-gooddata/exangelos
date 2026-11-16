import copy
import json
import unittest
import tempfile
from pathlib import Path
from unittest import mock
import scan
from types import SimpleNamespace

import observation
import projection
import wire

CHANNEL = 'C0000001'
TIME = '1700000000.000001'
RX = f'message-{TIME}-{CHANNEL}'
SELECTION = ('T0000001', 'U0000001', CHANNEL)
KEY = b'fixture-only-private-key-32-bytes!!'


def fixture():
    return {
        'bootData': {'user_id': SELECTION[1], 'token': 'must-be-skipped'},
        'selfTeamIds': {'teamId': SELECTION[0], 'defaultWorkspaceId': SELECTION[0]},
        'messages': {CHANNEL: {TIME: {'ts': TIME, 'type': 'message', 'text': 'fixture body', '_rxn_key': RX}}},
        'reactions': {RX: [{'name': 'wave', 'count': 1, 'users': ['U0000002']}]},
        'credentials': {'text': 'must-also-be-skipped'}
    }


def uint(n):
    out = bytearray()
    while n >= 128:
        out.append((n & 127) | 128)
        n >>= 7
    out.append(n)
    return bytes(out)


def encode(value):
    if value is None:
        return b'0'
    if isinstance(value, bytes):
        return value
    if isinstance(value, str):
        data = value.encode('utf8')
        return b'S' + uint(len(data)) + data
    if isinstance(value, bool):
        return b'T' if value else b'F'
    if isinstance(value, int):
        return b'U' + uint(value)
    if isinstance(value, list):
        return b'A' + uint(len(value)) + b''.join(map(encode, value)) + b'$\x00' + uint(len(value))
    if isinstance(value, dict):
        return b'o' + b''.join(encode(k) + encode(v) for k, v in value.items()) + b'{' + uint(len(value))
    raise ValueError('fixture')


def projected(value):
    return projection.project(b'\xff\x10' + encode(value))


class DirectTests(unittest.TestCase):
    def test_projection_and_scope_join_without_private_fields(self):
        state = projected(fixture())
        self.assertNotIn('token', state['bootData'])
        self.assertNotIn('credentials', state)
        snap = observation.snapshot(state, SELECTION, KEY)
        self.assertTrue(snap['complete'])
        self.assertEqual(len(snap['messages'][0]['reactions']), 1)
        encoded = json.dumps(snap)
        for raw in (*SELECTION, TIME, 'fixture body', 'wave', 'U0000002'):
            self.assertNotIn(raw, encoded)
        with self.assertRaisesRegex(ValueError, '^scope$'):
            observation.snapshot(state, ('OTHER', *SELECTION[1:]), KEY)

    def test_new_reply_edit_and_reaction_transitions(self):
        first = fixture()
        second = copy.deepcopy(first)
        second['messages'][CHANNEL][TIME]['text'] = 'fixture edit'
        second['reactions'][RX] = [{'name': 'heart', 'count': 1, 'users': ['U0000002']}]
        reply = '1700000001.000001'
        reply_rx = f'message-{reply}-{CHANNEL}'
        second['messages'][CHANNEL][reply] = {'ts': reply, 'thread_ts': TIME, 'text': 'fixture reply', '_rxn_key': reply_rx}
        second['reactions'][reply_rx] = []
        a = observation.snapshot(projected(first), SELECTION, KEY)
        b = observation.snapshot(projected(second), SELECTION, KEY)
        self.assertEqual(observation.compare(a, b), {'new_messages': 0, 'new_replies': 1, 'body_changes': 1, 'reactions_added': 1, 'reactions_removed': 1})
        self.assertTrue(all(value == 0 for value in observation.compare(b, b).values()))
        self.assertEqual(a['messages'][0]['id'], b['messages'][0]['id'])

    def test_missing_reaction_state_does_not_mean_removal(self):
        state = projected(fixture())
        a = observation.snapshot(state, SELECTION, KEY)
        state['reactions'] = {}
        b = observation.snapshot(state, SELECTION, KEY)
        self.assertFalse(b['complete'])
        self.assertEqual(observation.compare(a, b)['reactions_removed'], 0)

    def test_missing_or_skipped_manifest_table_fails_before_reconciliation(self):
        edit = SimpleNamespace(deleted_files=[], new_files=[SimpleNamespace(file_no=7, file_size=8)], log_number=9, prev_log_number=None)
        class Manifest:
            damage = []
            def __iter__(self):
                return iter([edit])
            def close(self):
                pass
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            folder = root / 'https_app.slack.com_0.indexeddb.leveldb'
            folder.mkdir()
            (folder / 'CURRENT').write_bytes(b'MANIFEST-000001\n')
            (folder / 'MANIFEST-000001').write_bytes(b'fixture')
            for symlink in (False, True):
                with self.subTest(symlink=symlink):
                    if symlink:
                        (folder / '000007.ldb').symlink_to(folder / 'missing')
                    with mock.patch.object(scan.ldb, 'ManifestFile', return_value=Manifest()), mock.patch.object(scan.acquire, 'reconcile', side_effect=AssertionError('must not reconcile')):
                        with self.assertRaisesRegex(ValueError, '^missing_table$'):
                            scan.run(root)

    def test_newest_tombstone_suppresses_old_blob_record(self):
        import collections
        old = SimpleNamespace(user_key=b'key', seq=1, state=1, value=b'old')
        tombstone = SimpleNamespace(user_key=b'key', seq=2, state=0, value=b'')
        self.assertEqual(wire.reconcile([tombstone, old], collections.Counter()), [tombstone])


if __name__ == '__main__':
    unittest.main()
