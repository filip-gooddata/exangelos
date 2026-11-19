import json
import os
import shutil
from pathlib import Path
import tempfile
import unittest
from unittest import mock

import setup
import source
import test_source
from test_direct import fixture, SELECTION


class SetupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name).resolve() / 'different-user-home'
        self.home.mkdir()
        self.environment = mock.patch.dict(os.environ, {
            'HOME': str(self.home), 'EXANGELOS_HOME': str(self.home / 'state'),
            'XDG_DATA_HOME': str(self.home / 'xdg'), 'XDG_CONFIG_HOME': str(self.home / 'config'),
            'XDG_CACHE_HOME': str(self.home / 'cache'), 'APPDATA': str(self.home / 'roaming'),
            'LOCALAPPDATA': str(self.home / 'local'),
        })
        self.environment.start()
        self.addCleanup(self.environment.stop)
        self.platform = mock.patch.object(setup.sys, 'platform', 'darwin')
        self.platform.start()
        self.addCleanup(self.platform.stop)
        self.values = {'sourceMode': 'persisted-cache', 'conversationSnippet': 'fixture body'}

    def database(self, root, identity=SELECTION):
        root.mkdir(parents=True, exist_ok=True)
        state = fixture()
        state['bootData']['user_id'] = identity[1]
        state['selfTeamIds'] = {'teamId': identity[0], 'defaultWorkspaceId': identity[0]}
        state['messages'] = {identity[2]: next(iter(state['messages'].values()))}
        state['reactions'] = {}
        for message in state['messages'][identity[2]].values():
            message['_rxn_key'] = f"message-{message['ts']}-{identity[2]}"
        with mock.patch.object(test_source, 'SELECTION', identity):
            test_source.database(root, state)

    def test_two_users_layouts_accounts_and_renamed_home(self):
        results = []
        for location, identity in [('standard', SELECTION), ('sandbox', ('T0000022', 'U0000033', 'C0000044'))]:
            home = self.home / location
            home.mkdir()
            with mock.patch.dict(os.environ, HOME=str(home), EXANGELOS_HOME=str(home / 'private-state')):
                self.database(setup.locations('')[location], identity)
                request = setup.setup(self.values)
                self.assertEqual(request['selection'], dict(workspace=identity[0], owner=identity[1], conversations=[identity[2]]))
                self.assertTrue(request['root'].startswith(str(home)))
                self.assertEqual(request, setup.setup(self.values))
                snapshot = source.acquire(request)
                self.assertEqual(len(snapshot['messages']), 1)
                self.assertTrue(snapshot['complete'])
                results.append((request['key'], snapshot['scope']))
                path = home / 'private-state/connectors/slack/setup.json'
                self.assertEqual(path.stat().st_mode & 0o777, 0o600)
                self.assertNotIn('fixture body', path.read_text())
                renamed = self.home / (location + '-renamed')
                home.rename(renamed)
            with mock.patch.dict(os.environ, HOME=str(renamed), EXANGELOS_HOME=str(renamed / 'private-state')):
                moved = setup.setup(self.values)
                self.assertEqual(moved['selection'], request['selection'])
                self.assertEqual(moved['key'], request['key'])
                self.assertEqual(source.acquire(moved)['scope'], snapshot['scope'])
        self.assertNotEqual(results[0][0], results[1][0])
        self.assertNotEqual(results[0][1], results[1][1])

    def test_direct_id_links_and_selector_free_resume(self):
        root = setup.locations('')['standard']
        self.database(root)
        team, _, conversation = SELECTION
        values = {'sourceMode': 'persisted-cache'}
        for selector in (conversation, f'https://fixture.slack.com/archives/{conversation}/p123'):
            request = setup.setup(dict(values, conversationId=selector))
            self.assertEqual(request, setup.setup(values))
        with self.assertRaisesRegex(setup.SetupRejected, '24'):
            setup.setup(dict(values, selectionRevision='2'))
        linked = setup.setup(dict(values, selectionRevision='2',
                                  conversationId=f'https://app.slack.com/client/{team}/{conversation}'))
        self.assertEqual(request['selection'], linked['selection'])
        self.assertNotEqual(request['key'], linked['key'])

    def test_selector_failures_do_not_create_pin(self):
        root = setup.locations('')['standard']
        self.database(root)
        for selector, code in [('https://other.invalid/archives/' + SELECTION[2], 20),
                               (f'https://app.slack.com/client/T0000022/{SELECTION[2]}', 22),
                               ('D0000099', 22)]:
            with self.assertRaisesRegex(setup.SetupRejected, str(code)):
                setup.setup({'sourceMode': 'persisted-cache', 'conversationId': selector})
        with self.assertRaisesRegex(setup.SetupRejected, '20'):
            setup.setup(dict(self.values, conversationId=SELECTION[2]))
        self.database(setup.locations('')['sandbox'])
        with self.assertRaisesRegex(setup.SetupRejected, '23'):
            setup.setup({'sourceMode': 'persisted-cache', 'conversationId': SELECTION[2]})
        self.assertFalse((self.home / 'state/connectors/slack/setup.json').exists())

    def test_ambiguity_between_roots_accounts_and_custom_fallback(self):
        roots = setup.locations('')
        self.database(roots['standard'])
        self.database(roots['sandbox'], ('T0000022', 'U0000033', SELECTION[2]))
        with self.assertRaises(ValueError):
            setup.setup(self.values)
        self.assertFalse((self.home / 'state/connectors/slack/setup.json').exists())
        request = setup.setup(dict(self.values, cacheRoot=str(roots['sandbox'])))
        self.assertEqual(request['selection']['owner'], 'U0000033')
        self.assertEqual(request['root'], str(roots['sandbox']))

    def test_multiple_accounts_in_one_source_are_not_selected_by_order(self):
        root = setup.locations('')['standard']
        self.database(root)
        first = fixture()
        second = fixture()
        second['bootData']['user_id'] = 'U0000033'
        def scan(root, observe):
            observe(first, 10)
            observe(second, 20)
            return dict(external_rejections=0, files_changed=0, current_unchanged=True)
        with mock.patch.object(source.scan, 'run', side_effect=scan):
            with self.assertRaises(ValueError):
                setup.setup(self.values)
        self.assertFalse((self.home / 'state/connectors/slack/setup.json').exists())

    def test_missing_consent_does_not_read_app_or_write_state(self):
        with mock.patch.object(source, 'inventory', side_effect=AssertionError('app read')):
            for values in ({}, {'conversationSnippet': 'fixture body'}, {'sourceMode': 'other', 'conversationSnippet': 'fixture body'}):
                with self.assertRaises(ValueError):
                    setup.setup(values)
        self.assertFalse((self.home / 'state').exists())

    def test_pinned_account_never_reselected_and_explicit_reset(self):
        root = setup.locations('')['standard']
        self.database(root)
        request = setup.setup(self.values)
        saved = (self.home / 'state/connectors/slack/setup.json').read_bytes()
        self.database(root, ('T0000022', 'U0000033', SELECTION[2]))
        with self.assertRaises(ValueError):
            setup.setup(self.values)
        self.assertEqual(saved, (self.home / 'state/connectors/slack/setup.json').read_bytes())
        new = setup.setup(dict(self.values, selectionRevision='2'))
        self.assertEqual(new['selection']['owner'], 'U0000033')
        self.assertNotEqual(new['key'], request['key'])
        with self.assertRaises(ValueError):
            setup.setup(dict(self.values, selectionRevision='2', conversationSnippet='fixture'))

    def test_absent_unsupported_unreadable_and_symlink_roots(self):
        with self.assertRaises(ValueError):
            setup.setup(self.values)
        root = setup.locations('')['standard']
        self.database(root)
        other = setup.locations('')['sandbox']
        other.mkdir(parents=True)
        with self.assertRaises(FileNotFoundError):
            setup.setup(self.values)
        other.rmdir()
        other.symlink_to(root)
        with self.assertRaises(ValueError):
            setup.setup(self.values)
        other.unlink()
        with mock.patch.object(setup.sys, 'platform', 'linux'):
            with self.assertRaises(ValueError):
                setup.setup(self.values)
            result = setup.setup(dict(self.values, cacheRoot=str(root)))
            self.assertEqual(result['selection']['owner'], SELECTION[1])

    def test_replacement_between_setup_and_acquisition_requires_reset(self):
        root = setup.locations('')['standard']
        self.database(root)
        request = setup.setup(self.values)
        self.assertEqual(source.acquire(request)['scope'], request['expectedScope'])
        folder = root / 'https_app.slack.com_0.indexeddb.leveldb'
        moved = root / 'original-database'
        folder.rename(moved)
        shutil.copytree(moved, folder)
        with self.assertRaises(ValueError):
            source.acquire(request)
        legacy = {key: value for key, value in request.items() if key != 'expectedScope'}
        self.assertNotEqual(source.acquire(legacy)['scope'], request['expectedScope'])
        with self.assertRaises(ValueError):
            setup.setup(self.values)
        replacement = setup.setup(dict(self.values, selectionRevision='2'))
        self.assertEqual(source.acquire(replacement)['scope'], replacement['expectedScope'])
        self.assertNotEqual(replacement['expectedScope'], request['expectedScope'])

    def test_private_state_and_installation_guard(self):
        root = setup.locations('')['standard']
        self.database(root)
        setup.setup(self.values)
        path = self.home / 'state/connectors/slack/setup.json'
        path.chmod(0o644)
        with self.assertRaises(ValueError):
            setup.setup(self.values)
        with mock.patch.dict(os.environ, EXANGELOS_HOME=str(Path(setup.__file__).resolve().parent.parent)):
            with self.assertRaises(ValueError):
                setup.setup(self.values)


if __name__ == '__main__':
    unittest.main()
