from contextlib import closing
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

    def call(self, snap, cursor=None, **options):
        request = dict(snapshot=snap, observedAt=1700000000000, **options)
        if cursor is not None:
            request['cursor'] = cursor
        return ledger.reconcile(request, self.path)

    def count(self, table):
        with closing(sqlite3.connect(self.path)) as db, db:
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

    def notice(self, cursor, row, **options):
        notice = {field: row[field] for field in ('id', 'reply', 'messageTs', 'permalink', 'conversationLabel')}
        return self.call({'scope': token('scope')}, cursor, notification=notice, **options)

    def test_notification_waits_for_actionable_cache_and_delivers_once(self):
        cursor = self.call(snapshot(1, []))['cursor']
        row = message(2, reply=True)
        early = self.notice(cursor, row, includePreview=True)
        duplicate = self.notice(early['cursor'], row, includePreview=True)
        self.assertEqual(early['events'], [])
        self.assertEqual(duplicate['events'], [])
        partial = dict(row, preview='fixture')
        del partial['sender']
        unseen_author = self.call(snapshot(2, [partial]), duplicate['cursor'], includePreview=True)
        self.assertEqual(unseen_author['events'], [])
        unknown_domain = dict(row, preview='fixture', permalink=(
            'https://app.slack.com/client/T0000001/C0000001?message_ts=' + row['messageTs']))
        no_link = self.call(snapshot(3, [unknown_domain]), unseen_author['cursor'], includePreview=True)
        self.assertEqual(no_link['events'], [])
        ready = snapshot(4, [dict(row, preview='fixture')])
        created = self.call(ready, no_link['cursor'], includePreview=True)
        event, = created['events']
        self.assertEqual(event['type'], 'thread.reply')
        self.assertEqual(event['payload'], dict(version=1, count=1, sender=row['sender'], preview='fixture',
                         conversationLabel=row['conversationLabel'], permalink=row['permalink'], messageTs=row['messageTs']))
        self.assertEqual(self.call(ready, no_link['cursor'], includePreview=True), created)
        self.assertEqual(self.notice(created['cursor'], row)['events'], [])
        changed = self.call(snapshot(5, [dict(message(2, 'edit', ['reaction'], reply=True), preview='edited')]),
                            created['cursor'], includePreview=True)
        self.assertEqual([e['type'] for e in changed['events']], ['message.edited', 'reaction.added'])

    def test_body_edit_without_slack_edit_timestamp_while_arrival_pending(self):
        cursor = self.call(snapshot(1, []))['cursor']
        first = message(2, body='first text')
        del first['sender']
        pending = self.call(snapshot(2, [first]), cursor)
        ready = self.call(snapshot(3, [message(2, body='second text')]), pending['cursor'])
        self.assertEqual([event['type'] for event in ready['events']], ['message.new', 'message.edited'])

    def test_pending_changes_release_after_creation_with_stable_order_across_pages(self):
        cursor = self.call(snapshot(1, []))['cursor']
        row = message(2)
        del row['sender']
        for generation, body, reactions in [(2, 'first', []), (3, 'second', [token('wave')]), (4, 'third', [])]:
            row.update(body=token(body), reactions=reactions)
            result = self.call(snapshot(generation, [row]), cursor)
            self.assertEqual(result['events'], [])
            cursor = result['cursor']
        row.update(sender='Fixture Author', preview='final visible text')
        ready = snapshot(5, [row])
        with patch.object(ledger, 'MAX_BATCH', 2):
            events = []
            page = self.call(ready, cursor, includePreview=True)
            while True:
                events.extend(page['events'])
                if not page.get('retryObservation'):
                    break
                page = self.call(ready, page['cursor'], includePreview=True)
        self.assertEqual([e['type'] for e in events], ['message.new', 'message.edited', 'reaction.added',
                                                       'message.edited', 'reaction.removed'])
        self.assertEqual(len({e['dedupeKey'] for e in events}), len(events))
        self.assertTrue(all('preview' not in e['payload'] for e in events[1:]))
        self.assertEqual(self.count('deferred_changes'), 0)

    def test_pending_status_follows_subscription_and_preview_choice(self):
        cursor = self.call(snapshot(1, []))['cursor']
        row = message(1)
        reply = message(2, reply=True)
        snap = snapshot(2, [row, reply])
        pending = self.call(snap, cursor, includePreview=True, arrivals=['message.new'])
        self.assertEqual(pending['events'], [])
        self.assertEqual(ledger.pending_status(pending['cursor'], self.path),
                         [dict(delivery='arrival', awaiting=['opted-in excerpt'], messages=1)])
        disabled = self.call(snap, pending['cursor'], includePreview=False, arrivals=['message.new'])
        event, = disabled['events']
        self.assertEqual(event['type'], 'message.new')
        self.assertNotIn('preview', event['payload'])
        self.assertEqual(ledger.pending_status(disabled['cursor'], self.path), [])

    def test_upgrade_whitespace_file_marker_without_synthetic_edits(self):
        old = message(2, body=' ')
        snap = snapshot(1, [old])
        cursor = self.call(snap)['cursor']
        canonical = dict(old, body=token(''), fileShare=True)
        upgraded = dict(snap, messages=[dict(canonical, legacyBody=old['body'])])
        migration = self.call(upgraded, cursor)
        self.assertEqual(migration['events'], [])
        empty = self.call(snapshot(2, [canonical]), migration['cursor'])
        self.assertEqual(empty['events'], [])
        edit, = self.call(snapshot(3, [dict(canonical, body=token('edit timestamp'))]), empty['cursor'])['events']
        self.assertEqual(edit['type'], 'message.edited')

    def test_cache_first_preview_enrichment_in_same_generation(self):
        cursor = self.call(snapshot(1, []))['cursor']
        row = message(2)
        snap = snapshot(2, [row])
        partial = self.call(snap, cursor, includePreview=True)
        self.assertEqual(partial['events'], [])
        self.assertEqual(self.notice(partial['cursor'], row, includePreview=True)['events'], [])
        self.assertEqual(self.call(snap, partial['cursor'], includePreview=True)['events'], [])
        row.update(preview='excerpt', memberSender='Example')
        ready = self.call(snap, partial['cursor'], includePreview=True)
        event, = ready['events']
        self.assertEqual(event['type'], 'message.new')
        self.assertEqual(event['payload']['count'], 1)
        self.assertEqual(event['payload']['sender'], 'Example')
        self.assertEqual(event['payload']['preview'], 'excerpt')
        self.assertEqual(self.call(snap, ready['cursor'], includePreview=True)['events'], [])
        replay, = self.call(snap, partial['cursor'])['events']
        self.assertNotIn('preview', replay['payload'])
        self.assertNotIn('excerpt', replay['summary'])

    def test_cache_first_sender_enrichment_without_preview_consent(self):
        cursor = self.call(snapshot(1, []))['cursor']
        row = dict(message(2), preview='private excerpt')
        del row['sender']
        partial = self.call(snapshot(2, [row]), cursor)
        self.assertEqual(partial['events'], [])
        empty = self.call(snapshot(3, []), partial['cursor'])
        self.assertEqual(empty['events'], [])
        snap = snapshot(4, [row])
        returned = self.call(snap, empty['cursor'])
        self.assertEqual(returned['events'], [])
        row['memberSender'] = 'Example'
        ready = self.call(snap, returned['cursor'])
        event, = ready['events']
        self.assertEqual(event['type'], 'message.new')
        self.assertEqual(event['payload']['count'], 1)
        self.assertEqual(event['payload']['sender'], 'Example')
        self.assertNotIn('preview', event['payload'])
        self.assertNotIn('private excerpt', event['summary'])
        self.assertEqual(self.call(snap, ready['cursor'])['events'], [])

    def migrated_receipt(self, version=5):
        # Synthetic receipt produced by the v5/v6 notification writer with fixed UUIDs.
        row = message(2, reply=True)
        lineage, source, tip = (f'{n:032x}' for n in (1, 2, 3))
        context = {field: row[field] for field in ('messageTs', 'permalink', 'conversationLabel')}
        receipt = dict(type='thread.reply', occurredAt=1700000000000, payload=dict(context, count=1, version=1),
                       dedupeKey='slack:e86ad43449fc4f3e2045365555772e3091cf603039f9ec1a5292ab77420c4614',
                       summary='Thread reply by unknown author in "#fixture" (message time 2023-11-14 22:13:20.000003 UTC)')
        early = dict(events=[receipt], cursor=f'4:{lineage}:{tip}')
        self.path.parent.mkdir(parents=True)
        with closing(sqlite3.connect(self.path)) as db, db:
            for sql in ledger.SCHEMA:
                db.execute(sql)
            db.execute(ledger.FLOORS)
            db.execute('INSERT INTO watch_starts VALUES (?,?)', (lineage, 1700000000000))
            for commit in (source, tip):
                db.execute('INSERT INTO commits VALUES (?,?,?,?,?,?)',
                           (lineage, commit, token('scope'), '1', token('[]'), '2:' + token('[]')))
            db.execute('INSERT INTO edges VALUES (?,?,?)', (lineage, source, ledger.packed(early)))
            if version == 5:
                db.execute('CREATE TABLE early (lineage TEXT, message TEXT, PRIMARY KEY(lineage,message))')
                db.execute('INSERT INTO early VALUES (?,?)', (lineage, row['id']))
            else:
                db.execute('CREATE TABLE pending_details (lineage TEXT, message TEXT, reply INTEGER, '
                           'need_sender INTEGER, need_preview INTEGER, PRIMARY KEY(lineage,message))')
                db.execute('INSERT INTO pending_details VALUES (?,?,1,1,1)', (lineage, row['id']))
            db.execute(f'PRAGMA user_version={version}')
        return row, early

    def test_read_only_status_keeps_one_snapshot_during_migration(self):
        _, receipt = self.migrated_receipt()
        connection = sqlite3.connect(self.path)
        self.addCleanup(connection.close)
        connection.execute('PRAGMA journal_mode=WAL')
        connection.execute('SELECT count(*) FROM commits').fetchone()
        connect = sqlite3.connect
        path = self.path

        class MigratingReader(sqlite3.Connection):
            def execute(self, sql, *args):
                if 'sqlite_master' in sql:
                    with closing(ledger.open_ledger(path, True)) as writer:
                        writer.commit()
                return super().execute(sql, *args)

        def connect_with_migration(database, **kwargs):
            if kwargs.get('uri'):
                kwargs['factory'] = MigratingReader
            return connect(database, **kwargs)

        with patch.object(sqlite3, 'connect', connect_with_migration):
            during = ledger.pending_status(receipt['cursor'], path)
        self.assertEqual(during, [dict(delivery='legacy details', fieldsRecorded=False, messages=1)])
        after, = ledger.pending_status(receipt['cursor'], path)
        self.assertEqual((after['delivery'], after['messages']), ('legacy details', 1))

    def test_v6_pending_receipt_gets_one_actionable_details_event(self):
        row, early = self.migrated_receipt(6)
        self.assertEqual(ledger.pending_status(early['cursor'], self.path),
                         [dict(delivery='legacy details', awaiting=['author', 'opted-in excerpt'], permalinkRecorded=False, messages=1)])
        snap = snapshot(2, [row])
        partial = self.call(snap, early['cursor'], includePreview=True)
        self.assertEqual(partial['events'], [])
        row['preview'] = 'original excerpt'
        result = self.call(snap, partial['cursor'], includePreview=True)
        details, = result['events']
        self.assertEqual(details['type'], 'thread.reply')
        self.assertEqual(details['payload']['count'], 0)
        self.assertEqual(details['payload']['delivery'], 'details')
        self.assertEqual(details['payload']['detailsFor'], early['events'][0]['dedupeKey'])
        self.assertEqual(details['payload']['preview'], 'original excerpt')
        self.assertEqual(self.call(snap, result['cursor'], includePreview=True)['events'], [])

    def test_missing_migrated_receipt_rolls_back_and_preserves_cursor(self):
        row, early = self.migrated_receipt()
        self.assertEqual(ledger.pending_status(early['cursor'], self.path),
                         [dict(delivery='legacy details', fieldsRecorded=False, messages=1)])
        with closing(sqlite3.connect(self.path)) as db, db:
            edge = db.execute('SELECT lineage,source,result FROM edges').fetchone()
            db.execute('DELETE FROM edges')
        commits = self.count('commits')
        with self.assertRaises(ledger.ObservationGap):
            self.call(snapshot(2, [row]), early['cursor'])
        self.assertEqual(self.count('commits'), commits)
        self.assertEqual(self.count('edges'), 0)
        self.assertEqual(self.count('early'), 1)
        with closing(sqlite3.connect(self.path)) as db, db:
            db.execute('INSERT INTO edges(lineage,source,result) VALUES (?,?,?)', edge)
        details, = self.call(snapshot(2, [row]), early['cursor'])['events']
        self.assertEqual(details['payload']['detailsFor'], early['events'][0]['dedupeKey'])

    def test_migrated_receipt_only_supplements_its_verified_kind(self):
        row, early = self.migrated_receipt()
        wrong = self.call(snapshot(2, [dict(row, reply=False)]), early['cursor'])
        self.assertEqual(wrong['events'], [])
        corrected = self.call(snapshot(3, [row]), wrong['cursor'])
        details, = corrected['events']
        self.assertEqual(details['type'], 'thread.reply')
        self.assertEqual(details['payload']['detailsFor'], early['events'][0]['dedupeKey'])

    def test_numeric_timestamp_ties_and_preexisting_order_replay(self):
        rows = [dict(message(i), messageTs=ts, sender=f'U000000{i}') for i, ts in enumerate(
            ('1700000000.0000000003', '1700000000.1', '1700000000.0000000002', '1700000000.10'))]
        cursor = self.call(snapshot(1, rows))['cursor']
        batch = self.call(snapshot(2, [dict(row, body=token('edit')) for row in rows]), cursor)
        ties = sorted((rows[1], rows[3]), key=lambda row: row['id'])
        self.assertEqual([event['payload']['sender'] for event in batch['events']],
                         [row['sender'] for row in (rows[2], rows[0], *ties)])

        # A pre-upgrade edge may already be committed in a different order.
        batch['events'].reverse()
        with closing(sqlite3.connect(self.path)) as db, db:
            db.execute('UPDATE edges SET result=?', (ledger.packed(batch),))
        self.assertEqual(self.call(snapshot(3, []), cursor), batch)

    def test_upgrade_same_generation_with_a_suppressed_legacy_label(self):
        old = snapshot(1, [dict(message(1), sender='synthetic unsafe name')])
        cursor = self.call(old)['cursor']
        with closing(sqlite3.connect(self.path)) as db, db:
            db.execute('UPDATE commits SET digest=substr(digest, 3)')
        safe = snapshot(1, [message(1)])
        self.assertEqual(self.call(safe, cursor), {'events': [], 'cursor': cursor})
        for invalid in (snapshot(1, [message(1, body='different')]), snapshot(1, [])):
            with self.assertRaises(ledger.ObservationGap):
                self.call(invalid, cursor)
        self.assertEqual(self.call(snapshot(2, [message(1)]), cursor)['events'], [])

    def test_member_names_preserve_committed_cursor_and_exact_replay(self):
        baseline = snapshot(1, [message(1)])
        cursor = self.call(baseline)['cursor']
        baseline['messages'][0]['memberSender'] = 'Example'
        self.assertEqual(self.call(baseline, cursor), {'events': [], 'cursor': cursor})
        changed = snapshot(2, [message(1, 'edit')])
        first = self.call(changed, cursor)
        changed['messages'][0]['memberSender'] = 'Example'
        self.assertEqual(self.call(changed, cursor), first)
        self.assertEqual(first['events'][0]['payload']['sender'], 'U0000001')

    def test_only_eligible_edges_persist_previews(self):
        baseline = snapshot(1, [dict(message(1), preview='baseline only')])
        cursor = self.call(baseline)['cursor']
        updated = snapshot(2, [dict(message(1, 'edited', ['r']), preview='edited excerpt')])
        edit, reaction = self.call(updated, cursor, includePreview=True)['events']
        self.assertEqual(edit['payload']['preview'], 'edited excerpt')
        self.assertIn('Untrusted message excerpt: "edited excerpt"', edit['summary'])
        self.assertNotIn('edited excerpt', ledger.packed(reaction))
        self.assertIn('Reaction added (message author: "U0000001")', reaction['summary'])
        with closing(sqlite3.connect(self.path)) as db:
            self.assertFalse(any('preview' in metadata for metadata, in db.execute('SELECT metadata FROM versions')))
        self.assertNotIn(b'baseline only', self.path.read_bytes())

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
        stale = self.notice(initial['cursor'], message(998))
        self.assertEqual(stale, {'cursor': initial['cursor'], 'events': []})
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
        with closing(sqlite3.connect(self.path)) as db, db:
            db.execute('DROP TABLE deferred_changes')
            db.execute('DROP TABLE watch_starts')
            db.execute('DROP TABLE pending_details')
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
        with closing(sqlite3.connect(self.path)) as db, db:
            db.execute("CREATE TRIGGER fail_edge BEFORE INSERT ON edges BEGIN SELECT RAISE(ABORT,'synthetic'); END")
        with self.assertRaises(sqlite3.IntegrityError):
            self.call(snapshot(2, [message(1, 'edit'), message(2)]), base['cursor'])
        self.assertEqual(self.count('commits'), 1)
        self.assertEqual(self.count('versions'), 1)
        self.assertEqual(self.count('edges'), 0)
        with closing(sqlite3.connect(self.path)) as db, db:
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
