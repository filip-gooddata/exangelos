import json
import observation
import struct
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from test_direct import fixture, projected, encode, uint, SELECTION, CHANNEL, TIME


def framed(data):
    from ccl_simplesnappy.ccl_simplesnappy import crc32c
    crc = crc32c(b'\x01' + data)
    masked = (((crc >> 15) | (crc << 17)) + 0xa282ead8) & 0xffffffff
    return struct.pack('<IHB', masked, len(data), 1) + data


def database(root, state=None, sequence=10, *, additional_accounts=()):
    folder = root / 'https_app.slack.com_0.indexeddb.leveldb'
    folder.mkdir(exist_ok=True)
    (folder / 'CURRENT').write_bytes(b'MANIFEST-000001\n')
    (folder / 'MANIFEST-000001').write_bytes(framed(b'\x02\x02'))
    path = root / 'https_app.slack.com_0.indexeddb.blob/1/00'
    path.mkdir(parents=True, exist_ok=True)
    rows = [(b'\x00\x01\x00\x00\x01', 'reduxPersistence'.encode('utf-16-be')),
            (b'\x00\x01\x00\x00\x32\x01\x00', 'reduxPersistenceStore'.encode('utf-16-be'))]
    accounts = [(SELECTION[:2], state or fixture()), *additional_accounts]
    for number, (identity, document) in enumerate(accounts, 1):
        blob = b'\xff\x12\xff\x10' + encode(document)
        (path / f'{number:x}').write_bytes(blob)
        name = 'persist:slack-fixture-' + '-'.join(identity)
        suffix = b'\x01' + uint(len(name)) + name.encode('utf-16-be')
        rows.append((b'\x00\x01\x01\x01' + suffix, b'\x00\xff\x11\x01' + uint(len(blob)) + b'\x00'))
        rows.append((b'\x00\x01\x01\x03' + suffix, b'\x00' + uint(number) + b'\x00' + uint(len(blob))))
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
            message = snap['messages'][0]
            self.assertEqual(message['messageTs'], TIME)
            self.assertEqual(message['conversationLabel'], f'Slack conversation {CHANNEL}')
            self.assertEqual(message['permalink'], f'https://app.slack.com/client/{SELECTION[0]}/{CHANNEL}?message_ts={TIME}')
            self.assertNotIn('sender', message)
            self.assertEqual(snap['generation'], '13')
            self.assertEqual(first.stdout, self.invoke(request(root)).stdout)
            self.assertEqual(first.stderr, '')
            self.assertNotIn('preview', message)
            for enable in (True, False):
                enabled = self.invoke(dict(request(root), includePreview=enable))
                self.assertEqual(enabled.returncode, 0)
                result = json.loads(enabled.stdout)
                if enable:
                    self.assertEqual(result['messages'][0].pop('preview'), 'fixture body')
                self.assertEqual(result, snap)
            for invalid in (None, 1, 'true', {}):
                failed = self.invoke(dict(request(root), includePreview=invalid))
                self.assertEqual((failed.returncode, failed.stdout, failed.stderr),
                                 (1, '', 'Slack persisted source unavailable.\n'))
            self.assertNotIn('fixture body', json.dumps(snap))
            key = bytes.fromhex(request(root)['key'])
            legacy = observation.snapshot(projected(state), SELECTION, key, require_reactions=False)
            self.assertEqual(snap['snapshot'], observation.token(key, 'selected-snapshot-v1', snap['scope'], legacy['messages']))
            for raw in (SELECTION[1], str(root), 'ab' * 32):
                self.assertNotIn(raw, first.stdout)

    def test_invalid_file_text_keeps_peer_and_reactions(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            state = fixture()
            ts = '1700000001.000002'
            state['messages'][CHANNEL][ts] = dict(
                type='message', subtype='file_share', ts=ts, text=None, _rxn_key=f'message-{ts}-{CHANNEL}',
                files=[dict(id='F0000001', name='fixture.pdf')])
            database(root, state)
            query = request(root)
            result = self.invoke(query)
            self.assertEqual(result.returncode, 0, result.stderr)
            snapshot = json.loads(result.stdout)
            self.assertTrue(snapshot['complete'])
            peer, = snapshot['messages']
            self.assertEqual(peer['messageTs'], TIME)
            self.assertTrue(peer['reactionsComplete'])
            self.assertEqual(peer['reactions'], [observation.token(bytes.fromhex(query['key']), 'reaction', 'wave', 'U0000002')])

    def test_deleted_file_keeps_legacy_checkpoint_without_delivery(self):
        import ledger
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / 'cache'
            root.mkdir()
            state = fixture()
            row = state['messages'][CHANNEL][TIME]
            row.update(text='', subtype='file_share', deleted=True, files=[dict(id='F0000001')])
            database(root, state)
            query = request(root)
            current = json.loads(self.invoke(query).stdout)
            key = bytes.fromhex(query['key'])
            # Checkpoint fields produced by the 0.6.1 reader for this fixture.
            legacy_rows = [dict(
                messageTs=TIME, conversationLabel=f'Slack conversation {CHANNEL}',
                permalink=f'https://app.slack.com/client/{SELECTION[0]}/{CHANNEL}?message_ts={TIME}',
                id=observation.token(key, 'message', *SELECTION, TIME),
                body=observation.token(key, 'body', '', None), reply=False,
                reactions=[observation.token(key, 'reaction', 'wave', 'U0000002')], reactionsComplete=True)]
            marker = observation.token(key, 'selected-snapshot-v1', current['scope'], legacy_rows)
            self.assertEqual(current['snapshot'], marker)
            self.assertEqual(current['messages'][0]['fileUnavailable'], 'suppressed')
            db = Path(temp) / 'ledger.sqlite3'
            def reconcile(snap, **extra):
                return ledger.reconcile(dict(snapshot=snap, observedAt=1700000000000, **extra), db)
            previous = reconcile(dict(current, messages=legacy_rows, snapshot=marker))
            self.assertEqual(reconcile(current, cursor=previous['cursor'])['events'], [])
            self.assertEqual(reconcile(dict(current, generation='14'), cursor=previous['cursor'])['events'], [])

    def test_unrelated_undecodable_member_label_keeps_selected_watch_available(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            team, owner = 'T9999999', 'U9999999'
            other = fixture()
            other['bootData']['user_id'] = owner
            other['selfTeamIds'] = dict(teamId=team, defaultWorkspaceId=team)
            other['members'] = {owner: dict(id=owner, team=team, profile=dict(display_name=b'c\x02\x00\xd8'))}
            database(root, additional_accounts=[((team, owner), other)])
            result = self.invoke(dict(request(root), includePreview=True))
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout)['messages'][0]['preview'], 'fixture body')

    def test_member_names_preserve_existing_snapshot_marker(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            state = fixture()
            peer = 'U0000002'
            state['messages'][CHANNEL][TIME]['user'] = peer
            database(root, state)
            old = json.loads(self.invoke(request(root)).stdout)
            state['members'] = {peer: dict(id=peer, team=SELECTION[0], profile=dict(display_name='Example'))}
            database(root, state)
            current = json.loads(self.invoke(request(root)).stdout)
            self.assertEqual(current['messages'][0].pop('memberSender'), 'Example')
            self.assertEqual(current, old)

    def test_preview_uses_only_selected_conversation_and_thread(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            state = fixture()
            for channel, number, body, parent in [(CHANNEL, 2, 'selected reply', TIME),
                                                   (CHANNEL, 3, 'unrelated reply', '1700000000.000004'),
                                                   ('C0000002', 5, 'another conversation', TIME)]:
                timestamp = f'1700000000.{number:06}'
                state['messages'].setdefault(channel, {})[timestamp] = {
                    'type': 'message', 'ts': timestamp, 'thread_ts': parent, 'text': body,
                    '_rxn_key': f'message-{timestamp}-{channel}'}
            database(root, state)
            query = request(root)
            query.update(includePreview=True)
            query['selection']['thread'] = TIME
            result = self.invoke(query)
            self.assertEqual((result.returncode, result.stderr), (0, ''))
            self.assertEqual([row['preview'] for row in json.loads(result.stdout)['messages']], ['selected reply'])
            for excluded in ('fixture body', 'another conversation', 'unrelated reply'):
                self.assertNotIn(excluded, result.stdout)

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
            for fault in ('key', 'hidden', 'body', 'thread', 'timestamp', 'checksum', 'missing_log', 'symlink'):
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

    def test_missing_cache_and_changed_pin_have_distinct_private_failures(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            absent = self.invoke(request(root))
            self.assertEqual((absent.returncode, absent.stdout, absent.stderr), (21, '', ''))
            database(root)
            changed = self.invoke(dict(request(root), expectedScope='0' * 64))
            self.assertEqual((changed.returncode, changed.stdout, changed.stderr), (24, '', ''))

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
