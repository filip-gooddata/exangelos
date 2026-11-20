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


def message(identity, body='original', reactions=(), complete=True, reply=False):
    ts = f'1700000000.{identity + 1:06d}'
    return dict(id=token(identity), body=token(body), reactions=sorted(token(r) for r in reactions),
                reactionsComplete=complete, reply=reply, messageTs=ts, conversationLabel='#fixture',
                permalink=f'https://fixture.slack.com/archives/C0000001/p{ts.replace(".", "")}', sender='U0000001')


def snapshot(generation, messages, scope='scope'):
    return dict(scope=token(scope), generation=str(generation), complete=True,
                snapshot=token(ledger.packed(messages)), messages=messages)


class LedgerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / 'connector-state/slack/ledger.sqlite3'

    def call(self, snap, cursor=None):
        request = {'snapshot': snap, 'observedAt': 1700000000000}
        if cursor is not None:
            request['cursor'] = cursor
        return ledger.reconcile(request, self.path)

    def count(self, table):
        with sqlite3.connect(self.path) as db:
            return db.execute(f'SELECT count(*) FROM {table}').fetchone()[0]

    def test_ledger_path_rejects_package_and_symlink_alias_without_creating_files(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            package = root / 'installed'
            (package / 'direct').mkdir(parents=True)
            alias = root / 'alias'
            alias.symlink_to(package, target_is_directory=True)
            with patch.object(ledger, '__file__', str(package / 'direct/ledger.py')):
                for home in (package, alias, package / 'nested'):
                    with self.subTest(home=home.name), patch.dict(os.environ, {'EXANGELOS_HOME': str(home)}):
                        with self.assertRaises(ledger.ObservationGap):
                            ledger.ledger_path()
                external = root / 'external'
                with patch.dict(os.environ, {'EXANGELOS_HOME': str(external)}):
                    self.assertEqual(ledger.ledger_path(), external / 'connector-state/slack/ledger.sqlite3')
                self.assertEqual(list(package.iterdir()), [package / 'direct'])
                self.assertFalse(external.exists())

    def test_turnover_has_no_lifetime_ceiling_and_retains_exact_history(self):
        initial = [message(i) for i in range(500)]
        result = self.call(snapshot(1, initial))
        self.assertEqual(result['events'], [])
        for generation in range(2, 32):
            current = initial[1:] + [message(500 + generation)]
            result = self.call(snapshot(generation, current), result['cursor'])
            self.assertEqual([e['type'] for e in result['events']], ['message.new'])
        self.assertEqual(self.count('versions'), 530)
        result = self.call(snapshot(32, initial), result['cursor'])
        self.assertEqual(result['events'], [])
        self.assertEqual(self.count('versions'), 530)
        result = self.call(snapshot(33, [message(0, 'edited')]), result['cursor'])
        self.assertEqual([e['type'] for e in result['events']], ['message.edited'])
        result = self.call(snapshot(34, []), result['cursor'])
        result = self.call(snapshot(35, [message(0, 'edited')]), result['cursor'])
        self.assertEqual(result['events'], [])
        self.assertEqual(self.count('versions'), 531)

    def test_commit_before_return_crash_and_partial_delivery_replay(self):
        cursor = self.call(snapshot(1, [message(1)]))['cursor']
        changed = snapshot(2, [message(1, 'edit', ['a']), message(2)])
        # Exit the actual child after reconciliation commits, before any stdout.
        code = 'import json,os,sys,ledger; ledger.reconcile(json.load(sys.stdin)); os._exit(17)'
        env = dict(os.environ, EXANGELOS_HOME=self.temp.name, PYTHONDONTWRITEBYTECODE='1')
        child = subprocess.run([sys.executable, '-c', code], cwd=Path(__file__).parent,
                               input=json.dumps({'observedAt': 1700000000000, 'cursor': cursor, 'snapshot': changed}),
                               capture_output=True, text=True, env=env)
        self.assertEqual(child.returncode, 17)
        self.assertEqual(child.stdout, '')
        newer = snapshot(3, [message(1, 'later'), message(2), message(3)])
        replay = self.call(newer, cursor)
        self.assertEqual([e['type'] for e in replay['events']].count('message.edited'), 1)
        self.assertEqual(len(replay['events']), 3)
        for delivered in range(len(replay['events']) + 1):
            retry = self.call(snapshot(0, []), cursor)
            self.assertEqual(retry, replay)
            saved = {e['dedupeKey'] for e in replay['events'][:delivered]}
            saved.update(e['dedupeKey'] for e in retry['events'])
            self.assertEqual(len(saved), 3)
        next_result = self.call(newer, replay['cursor'])
        self.assertEqual(sorted(e['type'] for e in next_result['events']),
                         ['message.edited', 'message.new', 'reaction.removed'])
        self.assertEqual(self.call(newer, cursor), replay)

    def test_repeated_changes_use_distinct_revisions(self):
        result = self.call(snapshot(1, [message(1)]))
        keys = []
        for generation in range(2, 10):
            result = self.call(snapshot(generation, [message(1, str(generation % 2), ['a'] if generation % 2 else [])]), result['cursor'])
            keys.extend(e['dedupeKey'] for e in result['events'])
        self.assertEqual(len(keys), len(set(keys)))
        self.assertTrue(all(len(key) == 70 for key in keys))

    def test_no_cursor_is_independent_silent_baseline(self):
        snap = snapshot(1, [message(1)])
        first = self.call(snap)
        second = self.call(snap)
        self.assertNotEqual(first['cursor'], second['cursor'])
        change = snapshot(2, [message(1, 'edit')])
        a = self.call(change, first['cursor'])
        b = self.call(change, second['cursor'])
        self.assertEqual(len(a['events']), 1)
        self.assertEqual(len(b['events']), 1)
        self.assertNotEqual(a['events'], b['events'])
        self.assertEqual(self.call(change)['events'], [])

    def test_same_snapshot_stable_cursor_and_conflicts_fail(self):
        snap = snapshot(12345678901234567890, [message(1)])
        result = self.call(snap)
        for _ in range(10):
            self.assertEqual(self.call(snap, result['cursor']), result)
        self.assertEqual(self.count('commits'), 1)
        self.assertEqual(self.count('edges'), 0)
        self.assertLess(len(result['cursor']), 100)
        for bad in (snapshot(1, []), snapshot(snap['generation'], []),
                    dict(snap, messages=[message(1, 'conflict')]), dict(snap, scope=token('other'))):
            with self.assertRaises(ledger.ObservationGap):
                self.call(bad, result['cursor'])
        newer = self.call(snapshot(12345678901234567891, snap['messages']), result['cursor'])
        self.assertEqual(newer['events'], [])
        self.assertEqual(self.count('versions'), 1)

    def test_inclusive_start_preserves_microseconds_and_tracks_suppressed_rows(self):
        initial = ledger.reconcile({'observedAt': 1700000000002, 'startedAt': 1700000000001,
                                    'snapshot': snapshot(1, [])}, self.path)
        # These fixtures fall one microsecond before, exactly at, and one after the floor.
        changed = self.call(snapshot(2, [message(998), message(999), message(1000)]), initial['cursor'])
        self.assertEqual(sorted(event['payload']['messageTs'] for event in changed['events']),
                         ['1700000000.001000', '1700000000.001001'])
        edited = self.call(snapshot(3, [message(998, 'edit', ['wave'])]), changed['cursor'])
        self.assertEqual(sorted(event['type'] for event in edited['events']), ['message.edited', 'reaction.added'])

    def test_legacy_lineage_replays_its_original_edge_then_requires_new_baseline(self):
        original = self.call(snapshot(1, []))
        tip = self.call(snapshot(2, []), original['cursor'])
        lineage, source = original['cursor'].split(':')[1:]
        frozen = dict(tip, events=[{'type': 'message.new', 'occurredAt': 1000,
                                    'dedupeKey': 'slack:' + token('legacy')}])
        with sqlite3.connect(self.path) as db:
            db.execute('DROP TABLE watch_starts')
            db.execute('PRAGMA user_version=4')
            db.execute('UPDATE edges SET result=? WHERE lineage=? AND source=?',
                       (ledger.packed(frozen), lineage, source))
        self.assertEqual(self.call(snapshot(3, []), original['cursor']), frozen)
        with self.assertRaises(ledger.LegacyCursor):
            self.call(snapshot(3, []), tip['cursor'])
        fresh = self.call(snapshot(3, []))
        self.assertNotEqual(fresh['cursor'], tip['cursor'])
        self.assertEqual(self.call(snapshot(4, []), fresh['cursor'])['events'], [])
        self.assertEqual(self.call(snapshot(4, []), original['cursor']), frozen)

    def test_missing_corrupt_and_foreign_ledger_never_reset(self):
        snap = snapshot(1, [])
        with self.assertRaises(ledger.ObservationGap):
            self.call(snap, '4:' + 'a' * 32 + ':' + 'b' * 32)
        self.assertFalse(self.path.exists())
        original = self.call(snap)['cursor']
        self.path.unlink()
        with self.assertRaises(ledger.ObservationGap):
            self.call(snap, original)
        self.path.write_bytes(b'corrupt private material')
        for cursor in (None, original):
            with self.assertRaises((sqlite3.DatabaseError, ledger.ObservationGap)):
                self.call(snap, cursor)
            self.assertEqual(self.path.read_bytes(), b'corrupt private material')
        self.path.unlink()
        self.call(snap)
        with self.assertRaises(ledger.ObservationGap):
            self.call(snap, original)
        self.path.write_bytes(b'')
        with self.assertRaises(ledger.ObservationGap):
            self.call(snap)

    def test_transaction_rolls_back_metadata_and_edge(self):
        base = self.call(snapshot(1, [message(1)]))
        with sqlite3.connect(self.path) as db:
            db.execute("CREATE TRIGGER fail_edge BEFORE INSERT ON edges BEGIN SELECT RAISE(ABORT,'synthetic'); END")
        with self.assertRaises(sqlite3.IntegrityError):
            self.call(snapshot(2, [message(1, 'edit'), message(2)]), base['cursor'])
        self.assertEqual(self.count('commits'), 1)
        self.assertEqual(self.count('versions'), 1)
        self.assertEqual(self.count('edges'), 0)
        with sqlite3.connect(self.path) as db:
            db.execute('DROP TRIGGER fail_edge')
        result = self.call(snapshot(2, [message(1, 'edit'), message(2)]), base['cursor'])
        self.assertEqual(len(result['events']), 2)

    def test_incomplete_reactions_and_reply_conflict(self):
        result = self.call(snapshot(1, [message(1, reactions=['a'])]))
        result = self.call(snapshot(2, [message(1, complete=False)]), result['cursor'])
        self.assertEqual(result['events'], [])
        result = self.call(snapshot(3, [message(1, reactions=['b'])]), result['cursor'])
        self.assertEqual(result['events'], [])
        result = self.call(snapshot(4, [message(1, reactions=['c'])]), result['cursor'])
        self.assertEqual([e['type'] for e in result['events']], ['reaction.added', 'reaction.removed'])
        with self.assertRaises(ledger.ObservationGap):
            self.call(snapshot(5, [message(1, reply=True)]), result['cursor'])
        result = self.call(snapshot(5, [message(2, reply=True)]), result['cursor'])
        self.assertEqual(result['events'][0]['type'], 'thread.reply')

    def test_invalid_snapshots_and_only_metadata_persisted(self):
        snap = snapshot(1, [message(1)])
        invalid = [dict(snap, messages=[message(i) for i in range(501)]),
                   dict(snap, messages=[message(1), message(1)]), dict(snap, complete=False),
                   dict(snap, generation='01'), dict(snap, generation='1' * 21)]
        for field in ('messageTs', 'conversationLabel', 'permalink'):
            bad = copy.deepcopy(snap)
            del bad['messages'][0][field]
            invalid.append(bad)
        for field, value in [('messageTs', 1700000000.0), ('sender', 'bad\nname'), ('id', 'raw-id'), ('body', 'private body'), ('reply', 1),
                             ('reactions', [token('r')] * 2), ('reactionsComplete', None)]:
            bad = copy.deepcopy(snap)
            bad['messages'][0][field] = value
            invalid.append(bad)
        # Establish schema before probing rollback on invalid requests.
        self.call(snap)
        for bad in invalid:
            with self.assertRaises(ledger.ObservationGap):
                self.call(bad)
        enriched = copy.deepcopy(snap)
        enriched['credential'] = 'secret-credential'
        enriched['messages'][0]['text'] = 'private-body'
        self.call(enriched)
        raw = self.path.read_bytes()
        self.assertNotIn(b'secret-credential', raw)
        self.assertNotIn(b'private-body', raw)

    def test_competing_processes_commit_one_immutable_edge(self):
        cursor = self.call(snapshot(1, [message(1)]))['cursor']
        env = dict(os.environ, EXANGELOS_HOME=self.temp.name, PYTHONDONTWRITEBYTECODE='1')
        command = [sys.executable, str(Path(__file__).with_name('ledger.py'))]
        children = [subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                     stderr=subprocess.PIPE, text=True, env=env) for _ in range(2)]
        for child, body in zip(children, ('edit-a', 'edit-b')):
            child.stdin.write(json.dumps({'observedAt': 1700000000000, 'cursor': cursor, 'snapshot': snapshot(2, [message(1, body)])}))
            child.stdin.close()
            child.stdin = None
        outputs = [child.communicate(timeout=10) for child in children]
        self.assertEqual([child.returncode for child in children], [0, 0])
        self.assertEqual(outputs[0], outputs[1])
        self.assertEqual(self.count('edges'), 1)
        self.assertEqual(self.count('versions'), 2)

    def test_invalid_initial_snapshot_does_not_poison_new_ledger(self):
        with self.assertRaises(ledger.ObservationGap):
            self.call(snapshot(1, [message(1), message(1)]))
        self.assertFalse(self.path.exists())
        self.assertEqual(self.call(snapshot(1, []))['events'], [])

    def test_cli_redaction_paths_and_permissions(self):
        env = dict(os.environ, EXANGELOS_HOME=self.temp.name, PYTHONDONTWRITEBYTECODE='1')
        command = [sys.executable, str(Path(__file__).with_name('ledger.py'))]
        result = subprocess.run(command, input=json.dumps({'observedAt': 1700000000000, 'snapshot': snapshot(1, [])}), text=True, capture_output=True, env=env)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr, '')
        self.assertEqual(json.loads(result.stdout)['events'], [])
        self.assertEqual(self.path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.path.parent.stat().st_mode & 0o777, 0o700)
        for data in ('private-invalid-json', json.dumps({'cursor': 'private-cursor', 'snapshot': snapshot(1, [])})):
            result = subprocess.run(command, input=data, text=True, capture_output=True, env=env)
            self.assertEqual(result.returncode, 1)
            self.assertEqual(result.stdout, '')
            self.assertEqual(result.stderr, ledger.ERROR + '\n')
        with patch.dict(os.environ, {'EXANGELOS_HOME': '', 'XDG_DATA_HOME': self.temp.name}):
            self.assertEqual(ledger.ledger_path(), Path(self.temp.name) / 'exangelos/connector-state/slack/ledger.sqlite3')
        with patch.dict(os.environ, {'EXANGELOS_HOME': '', 'XDG_DATA_HOME': ''}):
            self.assertEqual(ledger.ledger_path(), Path.home() / '.local/share/exangelos/connector-state/slack/ledger.sqlite3')


if __name__ == '__main__':
    unittest.main()
