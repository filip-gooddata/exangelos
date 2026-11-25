import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

import ledger
import setup
import source
from test_direct import CHANNEL, TIME, SELECTION, fixture
from test_source import database


REPLY = '12345678901234567890.000010'
OTHER = '1700000001.000005'


def add_message(state, timestamp, thread=None, channel=CHANNEL):
    row = dict(ts=timestamp, user='U0000002', text='synthetic body', _rxn_key=f'message-{timestamp}-{channel}')
    if thread:
        row['thread_ts'] = thread
    state['messages'].setdefault(channel, {})[timestamp] = row


class SetupTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.home = Path(temp.name).resolve()
        self.root = self.home / 'cache'
        self.root.mkdir()
        env = mock.patch.dict(os.environ, HOME=str(self.home), EXANGELOS_HOME=str(self.home / 'state'))
        env.start()
        self.addCleanup(env.stop)
        self.state = fixture()
        self.state['bootData']['team_domain'] = 'fixture'
        add_message(self.state, REPLY, TIME)
        add_message(self.state, OTHER)
        database(self.root, self.state)
        self.values = dict(subscriptionAccess='persisted-cache', cacheRoot=str(self.root))

    def resolve(self, subject, **kwargs):
        return setup.setup(dict(self.values, subject=subject, **kwargs))

    def reject(self, code, subject, **kwargs):
        with self.assertRaises(setup.SetupRejected) as error:
            self.resolve(subject, **kwargs)
        self.assertEqual(error.exception.args, (code,))

    def test_conversation_and_message_aliases_pin_canonical_scopes(self):
        full = self.resolve(CHANNEL)
        thread = self.resolve(REPLY)
        self.assertEqual(full['label'], f'Slack conversation {CHANNEL}')
        self.assertEqual(thread['selection']['thread'], TIME)
        self.assertNotEqual(full['expectedScope'], thread['expectedScope'])
        self.assertEqual(self.resolve(TIME, scope='conversation'), full)
        self.assertEqual(self.resolve(REPLY, scope='conversation'), full)
        self.reject(27, TIME)
        archive = f'https://fixture.slack.com/archives/{CHANNEL}'
        self.assertEqual(self.resolve(archive), full)
        self.assertEqual(self.resolve(f'https://app.slack.com/client/{SELECTION[0]}/{CHANNEL}'), full)
        self.assertEqual(self.resolve(f'{CHANNEL}:{REPLY}'), thread)
        self.assertEqual(self.resolve(f'{archive}/p{REPLY.replace(".", "")}?cid={CHANNEL}&thread_ts={TIME}'), thread)
        self.assertEqual(self.resolve(TIME, scope='replies'), thread)
        self.assertEqual(self.resolve('scope-' + thread['expectedScope']), thread)
        self.assertEqual(self.resolve('scope-' + full['expectedScope']), full)

    def test_archive_domain_and_opaque_parent(self):
        url = f'https://fixture.slack.com/archives/{CHANNEL}/p' + TIME.replace('.', '')
        del self.state['bootData']['team_domain']
        database(self.root, self.state)
        self.reject(22, url)
        self.state['teams'] = {SELECTION[0]: dict(id=SELECTION[0], domain='fixture')}
        database(self.root, self.state)
        self.reject(22, url.replace('fixture.', 'other.'))
        self.reject(27, url)
        self.state['bootData']['team_domain'] = 'conflict'
        database(self.root, self.state)
        self.reject(22, url)
        for field in ('thread_ts', 'ts'):
            with self.subTest(field=field):
                row = self.state['messages'][CHANNEL][TIME]
                row[field] = b'^\x00'
                database(self.root, self.state)
                with self.assertRaises(ValueError) as error:
                    self.resolve(TIME)
                self.assertNotIsInstance(error.exception, setup.SetupRejected)
                row[field] = TIME

    def test_labels_only_from_selected_account_metadata(self):
        dm, peer = 'D9999999', 'U1234567'
        add_message(self.state, OTHER, channel=dm)
        self.state['channels'] = {CHANNEL: dict(name='fixture-name'), dm: dict(id=dm, user=peer)}
        self.state['users'] = {peer: dict(id=peer, profile=dict(display_name='Fixture Peer'))}
        row = self.state['messages'][dm][OTHER]
        row['user'] = 'U7654321'
        self.state['users'][row['user']] = dict(name='Unrelated Author')
        database(self.root, self.state)
        self.assertEqual(self.resolve(CHANNEL)['label'], 'Slack #fixture-name')
        self.assertEqual(self.resolve(dm)['label'], 'Slack DM with Fixture Peer')
        self.state['users'][peer]['profile']['display_name'] = 'unsafe\nname'
        database(self.root, self.state)
        self.assertEqual(self.resolve(dm)['label'], 'Slack DM with ' + peer)
        del self.state['channels'][dm]['user']
        database(self.root, self.state)
        self.assertEqual(self.resolve(dm)['label'], 'Slack conversation ' + dm)
        group = 'G7777777'
        add_message(self.state, OTHER, channel=group)
        self.state['channels'][group] = dict(is_mpim=True, name='mpdm-private-roster')
        database(self.root, self.state)
        self.assertEqual(self.resolve(group)['label'], 'Slack group DM ' + group)

    def test_opaque_identity_with_other_evidence_fails_closed(self):
        self.state['bootData']['team_id'] = b'^\x00'
        database(self.root, self.state)
        with self.assertRaises(ValueError) as error:
            self.resolve(TIME)
        self.assertNotIsInstance(error.exception, setup.SetupRejected)

    def test_held_setup_lock_returns_retryable_exit(self):
        directory = setup.private_directory()
        with setup.locked(directory):
            process = subprocess.run([sys.executable, str(Path(setup.__file__))], capture_output=True,
                                     input=json.dumps(dict(self.values, subject=CHANNEL)), text=True, timeout=10)
            self.assertEqual((process.returncode, process.stdout, process.stderr), (25, '', ''))
            self.assertFalse((directory / 'subscriptions-key.json').exists())
        self.assertEqual(self.resolve(CHANNEL)['selection']['conversations'], [CHANNEL])

    def test_concurrent_processes_share_the_same_scoped_pin(self):
        command = [sys.executable, str(Path(setup.__file__))]
        payload = json.dumps(dict(self.values, subject=REPLY))
        workers = [subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                    stderr=subprocess.PIPE, text=True) for _ in range(4)]
        for worker in workers:
            worker.stdin.write(payload)
            worker.stdin.close()
            worker.stdin = None
        responses = []
        for worker in workers:
            stdout, stderr = worker.communicate(timeout=30)
            self.assertEqual(worker.returncode, 0, stderr)
            responses.append(json.loads(stdout))
        self.assertTrue(all(response == responses[0] for response in responses))
        self.assertEqual(responses[0], self.resolve('scope-' + responses[0]['expectedScope']))

    def test_direct_and_group_ids(self):
        for prefix in ('D', 'G'):
            channel = prefix + CHANNEL[1:]
            add_message(self.state, TIME, channel=channel)
            database(self.root, self.state)
            request = self.resolve(channel)
            self.assertEqual(request['selection']['conversations'], [channel])

    def test_invalid_unknown_and_ambiguous_subjects(self):
        archive = f'https://fixture.slack.com/archives/{CHANNEL}'
        for invalid in ('selected', TIME + ' ', 'http' + archive[5:], archive + '#fragment',
                        archive + '/p123', archive + '/p1234567?thread_ts=' + TIME + '&cid=D0000002',
                        archive + '/p1234567?cid=' + CHANNEL + '&cid=' + CHANNEL,
                        'https://x.slack.com.evil/archives/' + CHANNEL):
            self.reject(20, invalid)
        self.reject(20, CHANNEL, scope='replies')
        self.reject(20, TIME, scope=None)
        self.reject(22, archive + '/p' + REPLY.replace('.', '') + '?thread_ts=' + OTHER)
        self.reject(22, f'https://app.slack.com/client/T9999999/{CHANNEL}')
        self.reject(22, '1700000000.00001')
        add_message(self.state, TIME, channel='G9999999')
        database(self.root, self.state)
        self.reject(23, TIME)
        self.assertEqual(self.resolve(f'{CHANNEL}:{TIME}', scope='replies')['selection']['thread'], TIME)

    def test_filtered_observations_and_ledger_cursor_binding(self):
        def snapshot(subject):
            request = self.resolve(subject)
            request.pop('label')
            return source.acquire(request)

        first = snapshot(REPLY)
        self.assertEqual([row['reply'] for row in first['messages']], [True])
        path = self.home / 'ledger.sqlite3'
        def reconcile(snap, **kwargs):
            return ledger.reconcile(dict(snapshot=snap, observedAt=1700000000000, **kwargs), path)
        cursor = reconcile(first)['cursor']
        for timestamp in (TIME, OTHER):
            self.state['messages'][CHANNEL][timestamp]['text'] += ' changed'
        add_message(self.state, '1700000002.000000', OTHER)
        database(self.root, self.state, sequence=30)
        second = snapshot(REPLY)
        self.assertEqual(first['snapshot'], second['snapshot'])
        transition = reconcile(second, cursor=cursor)
        self.assertEqual(transition['events'], [])
        cursor = transition['cursor']
        add_message(self.state, '1700000002.000001', TIME)
        database(self.root, self.state, sequence=40)
        events = reconcile(snapshot(REPLY), cursor=cursor)['events']
        self.assertEqual([event['type'] for event in events], ['thread.reply'])
        for other_scope in (CHANNEL, '1700000002.000000'):
            with self.assertRaises(ledger.ObservationGap):
                reconcile(snapshot(other_scope), cursor=cursor)

    def test_ambiguity_across_accounts_and_pinned_resume(self):
        with mock.patch.object(setup.sys, 'platform', 'darwin'):
            roots = setup.locations('')
            for root in roots.values():
                root.mkdir(parents=True)
            database(roots['standard'], self.state)
            self.values.pop('cacheRoot')
            roots['sandbox'].rmdir()
            first = self.resolve(REPLY)
            roots['sandbox'].mkdir()
            other = fixture()
            other['bootData']['user_id'] = 'U9999999'
            add_message(other, REPLY, TIME)
            with mock.patch('test_source.SELECTION', (SELECTION[0], 'U9999999', CHANNEL)):
                database(roots['sandbox'], other)
            url = f'https://fixture.slack.com/archives/{CHANNEL}/p' + REPLY.replace('.', '')
            self.reject(23, url)
            self.reject(23, REPLY)
            self.reject(23, CHANNEL)
            self.assertEqual(self.resolve('scope-' + first['expectedScope']), first)

    def test_two_accounts_in_one_indexeddb(self):
        workspace, owner = 'T0000002', 'U0000002'
        other = fixture()
        other['bootData'].update(user_id=owner, team_domain='second')
        other['selfTeamIds']['teamId'] = workspace
        other['selfTeamIds']['defaultWorkspaceId'] = workspace
        unique = '1234567890.000003'
        add_message(other, unique, TIME)
        database(self.root, self.state, additional_accounts=[((workspace, owner), other)])
        self.reject(23, CHANNEL)
        self.reject(23, TIME, scope='conversation')
        first = self.resolve(REPLY)
        second = self.resolve(unique)
        self.assertEqual(first['selection']['owner'], SELECTION[1])
        self.assertEqual(second['selection']['owner'], owner)
        self.assertEqual(second['selection']['workspace'], workspace)
        self.assertNotEqual(first['expectedScope'], second['expectedScope'])
        self.assertEqual(self.resolve('scope-' + second['expectedScope']), second)
        url = f'https://second.slack.com/archives/{CHANNEL}/p' + TIME.replace('.', '')
        self.assertEqual(self.resolve(url, scope='replies'), second)

    def test_restart_after_device_renumbering_preserves_verified_volume_and_cursor(self):
        # Run on POSIX CI with synthetic volume identities and a changed mount device number.
        with mock.patch.object(source, 'volume_uuid', return_value='1' * 32) as uuid:
            with mock.patch.object(setup.sys, 'platform', 'linux'):
                legacy = self.resolve(CHANNEL)
                unverified = self.resolve(REPLY)
            with mock.patch.object(setup.sys, 'platform', 'darwin'):
                migrated = self.resolve('scope-' + legacy['expectedScope'])
                self.assertEqual(migrated['expectedScope'], legacy['expectedScope'])
                self.assertEqual(migrated['key'], legacy['key'])
                self.assertEqual(self.resolve(CHANNEL), migrated)
                fresh = self.resolve(OTHER, scope='replies')
                self.assertEqual(fresh['volumeIdentity'], {'kind': 'volume'})
                for active in (fresh, migrated):
                    handle = 'scope-' + active['expectedScope']
                    req = {k: v for k, v in active.items() if k != 'label'}
                    snap = source.acquire(req)
                    before = ledger.reconcile(dict(snapshot=snap, observedAt=1700000000000), self.home / 'ledger')
                    original_stat = os.fstat

                    class Renumbered:
                        def __init__(self, fd):
                            self.info = original_stat(fd)
                            self.st_dev = self.info.st_dev + 1

                        def __getattr__(self, name):
                            return getattr(self.info, name)

                    with mock.patch.object(os, 'fstat', Renumbered):
                        self.assertEqual(self.resolve(handle), active)
                        raw = self.resolve(CHANNEL) if active == migrated else self.resolve(OTHER, scope='replies')
                        self.assertEqual(raw, active)
                        again = source.acquire(req)
                        self.assertEqual(again, snap)
                        self.assertEqual(ledger.reconcile(dict(snapshot=again, observedAt=1700000001000,
                                                               cursor=before['cursor']), self.home / 'ledger'),
                                         dict(events=[], cursor=before['cursor']))
                        self.reject(24, 'scope-' + unverified['expectedScope'])
                    uuid.return_value = '2' * 32
                    self.reject(24, handle)
                    self.assertNotEqual(self.resolve(CHANNEL)['expectedScope'], migrated['expectedScope'])
                    with self.assertRaises(source.PinnedScopeChanged):
                        source.acquire(req)
                    uuid.return_value = '1' * 32

    def test_raw_reference_migrates_an_existing_pin_before_first_watch_reopen(self):
        with mock.patch.object(setup.sys, 'platform', 'linux'):
            original = self.resolve(CHANNEL)
        with mock.patch.object(setup.sys, 'platform', 'darwin'), mock.patch.object(source, 'volume_uuid', return_value='3' * 32):
            raw = self.resolve(CHANNEL)
            self.assertEqual(raw['expectedScope'], original['expectedScope'])
            self.assertEqual(raw, self.resolve('scope-' + original['expectedScope']))
            self.assertEqual(raw['volumeIdentity']['kind'], 'legacy')

    def test_notification_watch_reopens_pin_without_cache_acquisition(self):
        handle = 'scope-' + self.resolve(CHANNEL)['expectedScope']
        with mock.patch.object(source, 'inventory', side_effect=AssertionError('cache scan')), \
                mock.patch.object(source, 'acquire', side_effect=AssertionError('cache read')):
            self.assertEqual(self.resolve(handle, pinOnly='true')['expectedScope'], handle[6:])

    def test_equivalent_root_spelling_reopens_same_pin(self):
        original = self.resolve(REPLY)
        for suffix in ('/', '/.', '/../cache'):
            alias = str(self.root) + suffix
            for subject in (REPLY, 'scope-' + original['expectedScope']):
                self.assertEqual(self.resolve(subject, cacheRoot=alias), original)

    def test_case_variant_uses_filesystem_identity(self):
        original = self.resolve(REPLY)
        handle = 'scope-' + original['expectedScope']
        variant = self.root.with_name('CACHE')
        if not variant.exists():
            variant.mkdir()
        if not variant.samefile(self.root):
            database(variant, self.state)
            self.reject(24, handle, cacheRoot=str(variant))
            self.assertNotEqual(self.resolve(REPLY, cacheRoot=str(variant))['expectedScope'], original['expectedScope'])
            return
        for subject in (handle, REPLY):
            resolved = self.resolve(subject, cacheRoot=str(variant))
            self.assertEqual(resolved['expectedScope'], original['expectedScope'])
            self.assertEqual(resolved['key'], original['key'])
            self.assertEqual(resolved['selection'], original['selection'])
        self.assertEqual(self.resolve(handle), original)

    def test_hidden_reply_in_another_thread_does_not_block_replay(self):
        pin = self.resolve(REPLY)
        handle = 'scope-' + pin['expectedScope']
        def observe():
            request = self.resolve(handle)
            request.pop('label')
            return source.acquire(request)
        def reconcile(snap, **kwargs):
            return ledger.reconcile(dict(snapshot=snap, observedAt=1700000000000, **kwargs), self.home / 'ledger')
        cursor = reconcile(observe())['cursor']
        add_message(self.state, '1700000002.000001', TIME)
        database(self.root, self.state, sequence=20)
        before = observe()
        batch = reconcile(before, cursor=cursor)
        self.assertEqual([event['type'] for event in batch['events']], ['thread.reply'])
        hidden = '1700000003.000001'
        self.state['messages'][CHANNEL][hidden] = dict(ts=hidden, thread_ts=OTHER, _hidden_stub=True)
        database(self.root, self.state, sequence=30)
        self.assertEqual(before['snapshot'], observe()['snapshot'])
        self.assertEqual(reconcile(observe(), cursor=cursor), batch)
        for parent in (TIME, None):
            self.state['messages'][CHANNEL][hidden]['thread_ts'] = parent
            database(self.root, self.state, sequence=40)
            with self.assertRaises(ValueError):
                observe()

    def test_old_pins_replacement_and_revocation_fail_closed(self):
        current = self.resolve(REPLY)
        handle = 'scope-' + current['expectedScope']
        directory = setup.private_directory()
        old = 'scope-' + 'f' * 64
        setup.save_json(directory / (old + '.json'), dict(revision='1', request=current))
        setup.save_json(directory / 'setup.json', dict(version=1, request=current))
        with mock.patch.object(source, 'inventory', side_effect=AssertionError('cache read')):
            self.reject(24, old)
            self.reject(20, 'selected')
            self.reject(26, handle, subscriptionAccess='disabled')
            self.reject(26, REPLY, subscriptionAccess='disabled')
        self.root.rename(self.home / 'original')
        self.root.mkdir()
        database(self.root, self.state)
        self.reject(24, handle)
        self.assertNotEqual(current['expectedScope'], self.resolve(REPLY)['expectedScope'])

    def test_process_wire_limits_and_private_pin(self):
        result = subprocess.run([sys.executable, str(Path(setup.__file__))], capture_output=True,
                                input=json.dumps(dict(self.values, subject=REPLY)), text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        request = json.loads(result.stdout)
        self.assertLess(len(request['label']), 128)
        self.assertNotIn('synthetic body', result.stdout)
        path = setup.private_directory() / ('scope-' + request['expectedScope'] + '.json')
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        self.assertNotIn('synthetic body', path.read_text())
        self.reject(24, 'scope-' + request['expectedScope'], cacheRoot=str(self.home))

    def test_no_consent_precedes_filesystem_access_and_old_bootstrap(self):
        with mock.patch.object(setup, 'locations', side_effect=AssertionError('access')):
            for values in ({}, dict(sourceMode='persisted-cache', conversationSnippet='text'),
                           dict(subscriptionAccess='disabled', subject=CHANNEL)):
                with self.assertRaisesRegex(setup.SetupRejected, '26'):
                    setup.setup(values)
        self.assertFalse((self.home / 'state').exists())
