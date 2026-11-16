"""Bounded synthetic tests; never reads a live cache or owner config."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import bridge as b
from test_serialization import dataset
from test_action_probe import message
from test_current_store import batch, edit, log


class BridgeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name).resolve()
        self.cache = self.root / 'owned-cache'
        self.cache.mkdir()
        self.config = self.root / 'config.json'
        self.env = patch.dict(os.environ, {'EXANGELOS_TEAMS_CONFIG': str(self.config),
                                          'EXANGELOS_TEAMS_CACHE': str(self.cache)})
        self.env.start()
        self.key = b'k' * 32

    def tearDown(self):
        self.env.stop()
        self.tmp.cleanup()

    def result(self, objects):
        view = dataset(objects)
        scope = b.action.fingerprint(self.key, 'scope', [str(self.cache), 1, 'synthetic-scope'])
        return b.envelope(view, str(self.cache), self.key, scope)

    def install(self, objects):
        view = dataset(objects)
        (self.cache / 'CURRENT').write_bytes(b'MANIFEST-000001\n')
        (self.cache / 'MANIFEST-000001').write_bytes(log(edit()))
        (self.cache / '000003.log').write_bytes(log(batch(1, [(k, 1, v) for k, v in view.items()])))

    def setup_config(self):
        with patch.object(b.action.c, 'private_snippet', return_value='private target'):
            b.run('setup')

    def test_real_synthetic_store_setup_and_subprocess_snapshot(self):
        self.install([message()])
        self.setup_config()
        first = json.loads(self.config.read_bytes())
        self.setup_config()
        self.assertEqual(first, json.loads(self.config.read_bytes()))
        self.assertEqual(self.config.stat().st_mode & 0o777, 0o600)
        proc = subprocess.run([sys.executable, str(Path(b.__file__)), 'snapshot'],
                              capture_output=True, timeout=15)
        self.assertEqual((proc.returncode, proc.stderr), (0, b''))
        out = json.loads(proc.stdout)
        self.assertEqual(set(out), {'scope', 'messages'})
        self.assertEqual(len(out['messages']), 1)
        self.assertNotIn(b'synthetic', proc.stdout)
        self.assertNotIn(str(self.root).encode(), proc.stdout)
        self.assertRegex(out['scope'], b.HEX)
        row = out['messages'][0]
        self.assertEqual(set(row), {'id', 'body', 'parent', 'reaction', 'reactions'})
        self.assertRegex(row['id'], b.HEX)
        self.assertRegex(row['body'], b.HEX)
        self.assertIsNone(row['reaction'])
        self.assertIsNone(row['reactions'])

    def test_database_boundary_keeps_selected_gaps_fatal(self):
        view = dataset([message()])
        scope = b.action.fingerprint(self.key, 'scope', [str(self.cache), 1, 'synthetic-scope'])
        # IDB key prefix: one-byte database/store/index identifiers.
        unsupported = b'\x01\xff\x11\x01'
        other = b'\x00\x02\x01\x01\x01\x01\x00x'
        selected = b'\x00\x01\x02\x01\x01\x01\x00x'
        for raw, value in dataset([message('other-db', content='other database body')]).items():
            db, store, index, _ = b.action.prefix(raw)
            if db and store and index == 1:
                view[bytes((raw[0], 2)) + raw[2:]] = value
        view[other] = unsupported
        self.assertEqual(len(b.envelope(view, str(self.cache), self.key, scope)['messages']), 1)
        with patch.object(b, 'acquire', return_value=view):
            self.setup_config()
            self.assertEqual(len(b.run('snapshot')['messages']), 1)
        for value in (unsupported, b'invalid'):
            view[selected] = value
            with self.assertRaises(ValueError):
                b.envelope(view, str(self.cache), self.key, scope)
        del view[selected]
        with self.assertRaises(ValueError):
            b.envelope(view, str(self.cache) + '-other', self.key, scope)
        moved = {bytes((raw[0], 3)) + raw[2:]: value for raw, value in dataset([message()]).items()}
        with self.assertRaises(ValueError):
            b.envelope(moved, str(self.cache), self.key, scope)

    def test_snapshot_rejects_other_conversation_conflicts_in_selected_database(self):
        self.install([message()])
        self.setup_config()
        self.install([message(), message('other', chatId='other-scope'),
                      message('other', chatId='other-scope', content='conflicting body')])
        with self.assertRaises(ValueError):
            b.run('snapshot')

    def test_other_conversation_native_membership_conflict_fails_closed(self):
        self.install([message()])
        self.setup_config()
        self.install([message(), message('other', chatId='other-scope', properties={}),
                      message('other', chatId='other-scope', properties={
                          'emotions': [{'key': 'like', 'users': [{'mri': 'synthetic-user'}]}]})])
        with self.assertRaises(ValueError):
            b.run('snapshot')

    def test_missing_empty_invalid_cache_fails_without_output(self):
        self.install([message()])
        self.setup_config()
        for data in (b'', b'secret exception text'):
            (self.cache / 'CURRENT').write_bytes(data)
            proc = subprocess.run([sys.executable, b.__file__, 'snapshot'], capture_output=True, timeout=15)
            self.assertEqual((proc.returncode, proc.stdout, proc.stderr),
                             (1, b'', b'teams_bridge_unavailable\n'))

    def test_body_parent_and_row_bounds_fail_closed(self):
        missing = message('missing')
        del missing['content']
        for objects in ([], [message(), missing], [message(content=None)],
                        [message(content=[])], [message(replyToId='a', parentMessageId='b')],
                        [message(replyToId=[])], [message(str(i)) for i in range(501)],
                        [message(), message(content='conflicting duplicate')]):
            with self.subTest(objects=len(objects)), self.assertRaises(ValueError):
                self.result(objects)

    def test_opaque_stability_changes_and_unknown_reactions(self):
        base = self.result([message()])
        self.assertEqual(base, self.result([message()]))
        edited = self.result([message(content='edited')])
        self.assertEqual(base['scope'], edited['scope'])
        self.assertEqual(base['messages'][0]['id'], edited['messages'][0]['id'])
        self.assertNotEqual(base['messages'][0]['body'], edited['messages'][0]['body'])
        for reaction in (None, 'x' * 70000):
            self.assertIsNone(self.result([message(reactions=reaction)])['messages'][0]['reaction'])
        empty = self.result([message(reactions=[])])
        self.assertRegex(empty['messages'][0]['reaction'], b.HEX)
        replies = self.result([message('parent'), message('reply', replyToId='parent')])
        self.assertIn(next(r['parent'] for r in replies['messages'] if r['parent']),
                      {r['id'] for r in replies['messages']})
        self.key = b'z' * 32
        self.assertNotEqual(base['scope'], self.result([message()])['scope'])

    def test_native_memberships_are_opaque_stable_and_ignore_user_timestamps(self):
        def row(emotions):
            return self.result([message(properties={'emotions': emotions})])['messages'][0]

        first = row([{'key': 'like', 'users': [{'mri': 'synthetic-a', 'value': 1},
                                              {'mri': 'synthetic-b', 'value': 2}]}])
        reordered = row([{'key': 'like', 'users': [{'mri': 'synthetic-b', 'value': 30},
                                                  {'mri': 'synthetic-a', 'value': 40}]}])
        self.assertEqual(first['reactions'], reordered['reactions'])
        self.assertEqual(len(first['reactions']), 2)
        for token in first['reactions']:
            self.assertRegex(token, b.HEX)
        changed_user = row([{'key': 'like', 'users': [{'mri': 'synthetic-c'}]}])
        changed_key = row([{'key': 'heart', 'users': [{'mri': 'synthetic-a'}]}])
        self.assertTrue(set(first['reactions']).isdisjoint(changed_user['reactions']))
        self.assertTrue(set(first['reactions']).isdisjoint(changed_key['reactions']))
        self.assertEqual(first['id'], changed_user['id'])
        self.assertEqual(first['body'], changed_user['body'])
        self.assertNotIn('synthetic', json.dumps(first))

    def test_native_empty_unknown_and_malformed_memberships(self):
        for properties in ({}, {'emotions': []}):
            self.assertEqual(self.result([message(properties=properties)])['messages'][0]['reactions'], [])
        self.assertIsNone(self.result([message()])['messages'][0]['reactions'])
        for properties in (None, [], {'emotions': None}, {'emotions': [None]},
                           {'emotions': [{'key': 'like', 'users': [{'mri': ''}]}]},
                           {'emotions': [{'key': 'like', 'users': [{'mri': 'synthetic-a'}, {'mri': 'synthetic-a'}]}]}):
            with self.subTest(properties=properties):
                self.assertIsNone(self.result([message(properties=properties)])['messages'][0]['reactions'])

    def test_insecure_and_symlink_config_rejected(self):
        self.install([message()])
        self.setup_config()
        self.config.chmod(0o644)
        with self.assertRaises(ValueError):
            b.run('snapshot')
        self.config.chmod(0o600)
        target = self.root / 'original'
        self.config.rename(target)
        self.config.symlink_to(target)
        with self.assertRaises(OSError):
            b.run('setup')
        self.config.unlink()
        os.link(target, self.config)
        with self.assertRaises(ValueError):
            b.run('snapshot')

    def test_setup_ambiguity_preserves_config_and_no_discovery(self):
        self.install([message()])
        self.setup_config()
        original = self.config.read_bytes()
        self.install([message(), message('other')])
        with patch.object(b.current_store, 'discover', side_effect=AssertionError), self.assertRaises(ValueError):
            self.setup_config()
        self.assertEqual(self.config.read_bytes(), original)

    def test_atomic_write_failure_preserves_config(self):
        self.install([message()])
        self.setup_config()
        original = self.config.read_bytes()
        with patch.object(b.os, 'replace', side_effect=OSError('private detail')), self.assertRaises(OSError):
            self.setup_config()
        self.assertEqual(self.config.read_bytes(), original)
        self.assertFalse(list(self.root.glob('.teams-*')))

    def test_missing_cache_and_empty_selected_scope(self):
        self.install([message()])
        self.setup_config()
        self.install([message(chatId='other-scope')])
        with self.assertRaises(ValueError):
            b.run('snapshot')
        self.cache.rename(self.root / 'moved')
        with self.assertRaises(OSError):
            b.run('snapshot')

    def test_import_failure_is_sanitized(self):
        isolated = self.root / 'isolated'
        isolated.mkdir()
        script = isolated / 'bridge.py'
        script.write_bytes(Path(b.__file__).read_bytes())
        (isolated / 'action_probe.py').write_text('raise RuntimeError("secret import error")')
        proc = subprocess.run([sys.executable, str(script), 'snapshot'],
                              capture_output=True, timeout=15)
        self.assertEqual((proc.returncode, proc.stdout, proc.stderr),
                         (1, b'', b'teams_bridge_unavailable\n'))


if __name__ == '__main__':
    unittest.main()
