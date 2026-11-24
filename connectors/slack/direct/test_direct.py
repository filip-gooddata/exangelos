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
    def test_message_context_uses_scoped_dm_and_sender_metadata(self):
        dm, peer = 'D0000001', 'U0000002'
        data = fixture()
        data['channels'] = {dm: {'user': peer}}
        data['users'] = {peer: {'id': peer, 'team_id': SELECTION[0], 'profile': {'display_name': 'Fixture Peer'}}}
        rows = data['messages'].pop(CHANNEL)
        rows[TIME].update(user=peer, _rxn_key=f'message-{TIME}-{dm}')
        data['messages'][dm] = rows

        def read():
            return observation.snapshot(projected(data), (*SELECTION[:2], dm), KEY, require_reactions=False)['messages'][0]

        context = read()
        self.assertEqual(context['conversationLabel'], 'Slack DM with Fixture Peer')
        self.assertEqual(context['sender'], 'Fixture Peer')
        data['users'][peer]['team_id'] = 'T9999999'
        self.assertEqual(read()['sender'], peer)
        data['members'] = {peer: dict(id=peer, team_id=SELECTION[0], profile=dict(display_name='Member Example'))}
        for nullish in (None, b'_'):
            data['users'][peer] = dict(id=peer, team_id=SELECTION[0], profile=nullish)
            delivered = read()
            self.assertEqual(delivered['memberSender'], 'Member Example')
            self.assertEqual(delivered['memberPeer'], 'Member Example')
        del rows[TIME]['user']
        rows[TIME].update(bot_id='B0000001', username='Fixture Bot')
        self.assertEqual(read()['sender'], 'Fixture Bot')

    def test_member_names_require_matching_identity_and_workspace(self):
        identity, team = 'U0000002', SELECTION[0]
        row = dict(id=identity, team_id=team, profile=dict(display_name='Example'))
        state = dict(members={identity: row})
        def name():
            return observation.member_name(projected(state), team, identity)
        self.assertEqual(name(), 'Example')
        for key, bad in [('id', 'U9999999'), ('team_id', 'T9999999'), ('team_id', None),
                         ('profile', dict(display_name='Example', team='T9999999')),
                         ('profile', dict(display_name='xoxb-example'))]:
            with self.subTest(key=key), mock.patch.dict(row, {key: bad}):
                self.assertIsNone(name())
        with mock.patch.dict(state, users={identity: dict(id=identity, team=team)}):
            self.assertEqual(name(), 'Example')
        for conflict in (dict(team='T9999999'), dict(id='U9999999'), dict(profile=dict(team='T9999999'))):
            with mock.patch.dict(state, users={identity: conflict}):
                self.assertIsNone(name())

    def test_optional_profile_strings_require_valid_framing(self):
        for malformed in (b'c\x01a', b'c\xfe\x01a'):
            with self.subTest(value=malformed), self.assertRaises(ValueError):
                projected(dict(members={'U0000002': dict(profile=dict(display_name=malformed))}))

    def test_optional_app_fallback_preserves_markers_and_requires_visible_layout(self):
        data = fixture()
        row = data['messages'][CHANNEL][TIME]
        row.update(text='', app_id='A0000001', attachments=[dict(title='Example layout')])

        def snapshot(enabled):
            state = projection.project(b'\xff\x10' + encode(data), [CHANNEL])
            return observation.snapshot(state, SELECTION, KEY, include_preview=enabled)

        for enabled in (False, True):
            row['text'] = ''
            reference = snapshot(enabled)
            self.assertTrue(reference['complete'])
            self.assertEqual(reference['messages'][0].get('preview'), 'Example layout' if enabled else None)
            del row['text']
            self.assertEqual(snapshot(enabled), reference)
            row['text'] = b'_'
            self.assertEqual(snapshot(enabled), reference)
        del row['text']
        for change in (dict(text=None), dict(text=42), dict(text={}), dict(type='unknown'),
                       dict(subtype='unsupported'), dict(app_id='invalid'), dict(hidden=True),
                       dict(redacted=True), dict(deleted=True), dict(subtype='message_deleted'),
                       dict(attachments=[dict(fallback='private metadata')]), dict(attachments=[dict(title=123)])):
            with self.subTest(change=change), mock.patch.dict(row, change):
                for enabled in (False, True):
                    result = snapshot(enabled)
                    self.assertFalse(result['complete'])
                    self.assertEqual(result['messages'], [])

    def test_delivery_preview_policy_after_projection(self):
        data = fixture()
        message = data['messages'][CHANNEL][TIME]

        def selected():
            return observation.snapshot(projected(data), SELECTION, KEY, require_reactions=False,
                                        include_preview=True)['messages'][0]

        message['subtype'] = b'_'  # V8 undefined
        message['text'] = '  Status\tupdate\r\n' + '🌻' * 180
        self.assertEqual(selected()['preview'], 'Status update ' + '🌻' * 146)
        for text, expected in [('', None), (' \t', None), ('🌻' * 5000, '🌻' * 160),
                               ('opaque ' + 's' * 40, 'opaque ' + 's' * 40),
                               ('credentials and password', 'credentials and password'),
                               ('before\x00after', 'before after'), ('user\u202ename', 'user name')]:
            message['text'] = text
            self.assertEqual(selected().get('preview'), expected)
        with mock.patch.dict('os.environ', {'FIXTURE_TOKEN': 'abcde', 'FIXTURE_KEY': 'defgh'}):
            message['text'] = 'before abcdefgh after'
            self.assertEqual(selected()['preview'], 'before [redacted] after')
        message['text'] = 'ordinary message'
        for subtype in (None, 1, False, {}, [], '', 'message_deleted'):
            message['subtype'] = subtype
            self.assertNotIn('preview', selected())
        del message['subtype']
        for field, value in [('is_redacted', True), ('deleted', True), ('redacted', 'unknown'), ('subtype', 'message_deleted')]:
            message[field] = value
            self.assertNotIn('preview', selected())
            del message[field]
        for field, value in [('hidden', True), ('no_display', None), ('_hidden_stub', 1)]:
            message[field] = value
            self.assertEqual(observation.snapshot(projected(data), SELECTION, KEY, include_preview=True)['messages'], [])
            del message[field]
        message.update(team=SELECTION[0], team_id='T9999999')
        with self.assertRaisesRegex(ValueError, '^scope$'):
            selected()

    def test_opted_in_app_visible_layout_projection(self):
        data = fixture()
        msg = data['messages'][CHANNEL][TIME]
        rich = dict(type='rich_text_section', elements=[
            dict(type='text', text='Changes to '),
            dict(type='link', text='the release', url='https://hidden.invalid')])
        msg.update(app_id='A0000001', text='', blocks=[dict(type='rich_text', elements=[rich])])

        def preview():
            state = projection.project(b'\xff\x10' + encode(data), [CHANNEL])
            return observation.snapshot(state, SELECTION, KEY, include_preview=True)['messages'][0].get('preview')

        self.assertEqual(preview(), 'Changes to the release')
        self.assertNotIn('blocks', projected(data)['messages'][CHANNEL][TIME])
        msg['text'] = 'Generic fallback'
        self.assertEqual(preview(), 'Changes to the release')
        rich['elements'][1]['text'] = 'a' * 40
        self.assertEqual(preview(), 'Changes to ' + 'a' * 40)
        del rich['elements'][1]['text']
        msg['blocks'][0]['elements'] = [dict(type='rich_text_list', elements=[rich])]
        self.assertEqual(preview(), 'Changes to https://hidden.invalid')
        msg['blocks'] = [dict(type='section', text=dict(type='mrkdwn', text='Read <https://fixture.invalid/path|the credential report>')),
                         dict(type='actions', elements=[dict(type='button', value='invisible', text=dict(type='plain_text', text='Open'))])]
        self.assertEqual(preview(), 'Read the credential report Open')
        msg.update(blocks=[], attachments=[dict(title='Issue updated', text='Ready for review',
                                                title_link='https://hidden.invalid', fallback='alternate')])
        self.assertEqual(preview(), 'Issue updated Ready for review')
        msg.update(attachments=[], text='<https://fixture.invalid/path|Release notes>')
        self.assertEqual(preview(), 'Release notes')
        msg['mrkdwn'] = False
        self.assertEqual(preview(), msg['text'])

    def test_mrkdwn_literal_spans_and_decoded_credential_boundaries(self):
        render = observation.render_mrkdwn
        self.assertEqual(render('*go _now_*'), 'go now')
        self.assertEqual(render('*https://example.invalid/a_b*'), 'https://example.invalid/a_b')
        self.assertEqual(render('`<url|*literal*>` and ```~keep~```'), '`<url|*literal*>` and ```~keep~```')
        self.assertEqual(render('a*b*c x_y_z 2 * 3 ~7 unmatched*'), 'a*b*c x_y_z 2 * 3 ~7 unmatched*')
        with mock.patch.dict('os.environ', {'FIXTURE_TOKEN': '*a&b*'}):
            self.assertEqual(render('before *a&amp;b* and _after_'), 'before [redacted] and after')

    def test_projected_user_and_channel_labels_fail_closed(self):
        data = fixture()
        author = 'U0000002'
        message = data['messages'][CHANNEL][TIME]
        message['user'] = author
        data['users'] = {author: {'name': 'Fixture Person', 'team_id': SELECTION[0]}}
        channel = {'name': 'fixture-channel', 'context_team_id': SELECTION[0]}
        data['channels'] = {CHANNEL: channel}

        def selected():
            return observation.snapshot(projected(data), SELECTION, KEY)['messages'][0]

        self.assertEqual(selected()['sender'], 'Fixture Person')
        self.assertEqual(selected()['conversationLabel'], 'Slack #fixture-channel')
        user = data['users'][author]
        for field, value in [('team', 'T9999999'), ('id', 'U9999999'), ('profile', {'team': 'T9999999'})]:
            user[field] = value
            self.assertEqual(selected()['sender'], author)
            del user[field]
        user['name'] = channel['name'] = 'xoxb-fixture'
        self.assertEqual(selected()['sender'], author)
        self.assertEqual(selected()['conversationLabel'], 'Slack conversation ' + CHANNEL)
        del data['users'][author]
        self.assertEqual(selected()['sender'], author)
        for field, value in [('team_id', 'T9999999'), ('id', 'C9999999')]:
            channel[field] = value
            with self.assertRaisesRegex(ValueError, '^scope$'):
                selected()
            del channel[field]

    def test_projection_and_scope_join_without_private_fields(self):
        state = projected(fixture())
        self.assertNotIn('token', state['bootData'])
        self.assertNotIn('credentials', state)
        snap = observation.snapshot(state, SELECTION, KEY)
        self.assertTrue(snap['complete'])
        self.assertEqual(len(snap['messages'][0]['reactions']), 1)
        encoded = json.dumps(snap)
        for raw in (SELECTION[1], 'fixture body', 'wave', 'U0000002'):
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
