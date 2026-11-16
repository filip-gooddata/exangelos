import copy
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import ledger


def token(value):
    return hashlib.sha256(str(value).encode()).hexdigest()


def message(identity, body='original', reactions=(), parent=None, reaction=None):
    return dict(id=token(identity), body=token(body),
                parent=None if parent is None else token(parent),
                reaction=None if reaction is None else token(reaction),
                reactions=None if reactions is None else sorted(token(r) for r in reactions))


def snapshot(messages, scope='scope'):
    return dict(scope=token(scope), messages=messages)


class LedgerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / 'connectors/teams/ledger.sqlite3'

    def call(self, messages, cursor=None, clock=1700000000000):
        request = {'snapshot': snapshot(messages), 'observedAt': clock}
        if cursor is not None:
            request['cursor'] = cursor
        return ledger.reconcile(request, self.path)

    def count(self, table):
        with sqlite3.connect(self.path) as db:
            return db.execute(f'SELECT count(*) FROM {table}').fetchone()[0]

    def test_turnover_and_returning_history(self):
        initial = [message(i) for i in range(500)]
        result = self.call(initial)
        self.assertEqual(result['events'], [])
        for i in range(30):
            result = self.call(initial[1:] + [message(500 + i)], result['cursor'])
            self.assertEqual([e['type'] for e in result['events']], ['message.new'])
        self.assertEqual(self.count('versions'), 530)
        result = self.call(initial, result['cursor'])
        self.assertEqual(result['events'], [])
        self.assertEqual(self.count('versions'), 530)
        result = self.call([message(0, 'edited')], result['cursor'])
        self.assertEqual([e['type'] for e in result['events']], ['message.edited'])
        result = self.call([message(1)], result['cursor'])
        result = self.call([message(0, 'edited')], result['cursor'])
        self.assertEqual(result['events'], [])
        self.assertEqual(self.count('versions'), 531)

    def test_committed_full_batch_replays_before_new_snapshot_and_clock(self):
        cursor = self.call([message(1)])['cursor']
        changed = [message(1, 'edit', ['a']), message(2, parent=1)]
        # Simulate a crash after committing, before delivering any output.
        code = 'import json,os,sys,ledger; ledger.reconcile(json.load(sys.stdin)); os._exit(17)'
        env = dict(os.environ, EXANGELOS_HOME=self.temp.name, PYTHONDONTWRITEBYTECODE='1')
        child = subprocess.run([sys.executable, '-c', code], cwd=Path(__file__).parent,
                               input=json.dumps({'observedAt': 123, 'cursor': cursor, 'snapshot': snapshot(changed)}),
                               capture_output=True, text=True, env=env)
        self.assertEqual(child.returncode, 17, child.stderr)
        self.assertEqual(child.stdout, '')
        newer = [message(1, 'later'), message(2, parent=1), message(3)]
        replay = self.call(newer, cursor, clock=456)
        self.assertEqual(sorted(e['type'] for e in replay['events']),
                         ['message.edited', 'message.reply', 'reaction.added'])
        self.assertEqual([e['occurredAt'] for e in replay['events']], [123] * 3)
        for delivered in range(4):
            retry = self.call([message(99)], cursor, clock=789)
            self.assertEqual(retry, replay)
            keys = {e['dedupeKey'] for e in replay['events'][:delivered]}
            keys.update(e['dedupeKey'] for e in retry['events'])
            self.assertEqual(len(keys), 3)
        result = self.call(newer, replay['cursor'], clock=456)
        self.assertEqual(sorted(e['type'] for e in result['events']),
                         ['message.edited', 'message.new', 'reaction.removed'])
        self.assertEqual([e['occurredAt'] for e in result['events']], [456] * 3)
        self.assertEqual(self.call(newer, cursor), replay)

    def test_independent_silent_baselines_and_stable_unchanged_cursor(self):
        first = self.call([message(1)])
        second = self.call([message(1)])
        self.assertEqual(first['events'], second['events'])
        self.assertEqual(first['events'], [])
        self.assertNotEqual(first['cursor'], second['cursor'])
        self.assertLess(len(first['cursor']), 100)
        self.assertEqual(self.call([message(1)], first['cursor']), first)
        a = self.call([message(1, 'edit')], first['cursor'])
        b = self.call([message(1, 'edit')], second['cursor'])
        self.assertEqual(len(a['events']), 1)
        self.assertEqual(len(b['events']), 1)
        self.assertNotEqual(a['events'], b['events'])
        self.assertEqual(self.call([message(1, 'edit')])['events'], [])

    def test_revisions_null_continuity_and_parent_gap(self):
        result = self.call([message(1, reactions=['a'])])
        for reactions in (None, ['b']):
            result = self.call([message(1, reactions=reactions)], result['cursor'])
            self.assertEqual(result['events'], [])
        result = self.call([message(1, reactions=['c'])], result['cursor'])
        self.assertEqual([e['type'] for e in result['events']], ['reaction.added', 'reaction.removed'])
        before = (self.count('commits'), self.count('versions'), self.count('edges'))
        with self.assertRaises(ledger.ObservationGap):
            self.call([message(1, parent='changed')], result['cursor'])
        self.assertEqual((self.count('commits'), self.count('versions'), self.count('edges')), before)
        keys = []
        for i in range(8):
            result = self.call([message(1, body=str(i % 2), reactions=['a'] if i % 2 else [])], result['cursor'])
            keys.extend(e['dedupeKey'] for e in result['events'])
        self.assertEqual(len(keys), len(set(keys)))
        self.assertTrue(all(len(key) == 70 for key in keys))
        result = self.call([message(1, body='1', reactions=['a'], reaction='summary')], result['cursor'])
        self.assertEqual(result['events'], [])

    def test_missing_corrupt_and_foreign_ledger_never_reset(self):
        with self.assertRaises(ledger.ObservationGap):
            self.call([message(1)], '3:' + 'a' * 32 + ':' + 'b' * 32)
        self.assertFalse(self.path.exists())
        cursor = self.call([message(1)])['cursor']
        self.path.unlink()
        with self.assertRaises(ledger.ObservationGap):
            self.call([message(1)], cursor)
        self.path.write_bytes(b'corrupt private material')
        for resume in (None, cursor):
            with self.assertRaises((sqlite3.DatabaseError, ledger.ObservationGap)):
                self.call([message(1)], resume)
            self.assertEqual(self.path.read_bytes(), b'corrupt private material')
        self.path.unlink()
        self.call([message(1)])
        with self.assertRaises(ledger.ObservationGap):
            self.call([message(1)], cursor)
        self.path.write_bytes(b'')
        with self.assertRaises(ledger.ObservationGap):
            self.call([message(1)])

    def test_invalid_snapshot_and_metadata_only(self):
        snap = snapshot([message(1)])
        invalid = [snapshot([]), snapshot([message(i) for i in range(501)]),
                   snapshot([message(1), message(1)])]
        for field, value in [('id', 'raw-id'), ('body', 'private body'), ('parent', True),
                             ('reaction', 'raw'), ('reactions', [token('r')] * 2),
                             ('reactions', [token(i) for i in range(501)])]:
            bad = copy.deepcopy(snap)
            bad['messages'][0][field] = value
            invalid.append(bad)
        for field in ('parent', 'reaction', 'reactions'):
            bad = copy.deepcopy(snap)
            del bad['messages'][0][field]
            invalid.append(bad)
        for bad in invalid:
            with self.assertRaises(ledger.ObservationGap):
                ledger.reconcile({'snapshot': bad, 'observedAt': 0}, self.path)
        self.assertFalse(self.path.exists())
        enriched = copy.deepcopy(snap)
        enriched['credential'] = 'secret-credential'
        enriched['messages'][0]['text'] = 'private-body'
        baseline = ledger.reconcile({'snapshot': enriched, 'observedAt': 0}, self.path)
        raw = self.path.read_bytes()
        self.assertNotIn(b'secret-credential', raw)
        self.assertNotIn(b'private-body', raw)
        with self.assertRaises(ledger.ObservationGap):
            ledger.reconcile({'snapshot': snapshot([message(1)], 'other'), 'observedAt': 0,
                              'cursor': baseline['cursor']}, self.path)

    def test_cli_paths_permissions_and_redacted_errors(self):
        env = dict(os.environ, EXANGELOS_HOME=self.temp.name, PYTHONDONTWRITEBYTECODE='1')
        command = [sys.executable, str(Path(__file__).with_name('ledger.py'))]
        result = subprocess.run(command, input=json.dumps({'observedAt': 0, 'snapshot': snapshot([message(1)])}),
                                text=True, capture_output=True, env=env)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)['events'], [])
        self.assertEqual(self.path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.path.parent.stat().st_mode & 0o777, 0o700)
        self.path.write_bytes(b'private corruption')
        for data in ('private-invalid-json', json.dumps({'observedAt': 0, 'snapshot': snapshot([message(1)])})):
            result = subprocess.run(command, input=data, text=True, capture_output=True, env=env)
            self.assertEqual(result.returncode, 1)
            self.assertEqual(result.stdout, '')
            self.assertEqual(result.stderr, ledger.ERROR + '\n')
        with patch.dict(os.environ, {'EXANGELOS_HOME': '', 'XDG_DATA_HOME': self.temp.name}):
            self.assertEqual(ledger.ledger_path(), Path(self.temp.name) / 'exangelos/connectors/teams/ledger.sqlite3')
        with patch.dict(os.environ, {'EXANGELOS_HOME': '', 'XDG_DATA_HOME': ''}):
            self.assertEqual(ledger.ledger_path(), Path.home() / '.local/share/exangelos/connectors/teams/ledger.sqlite3')


if __name__ == '__main__':
    unittest.main()
