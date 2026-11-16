"""Portable selection tests use only synthetic homes and LevelDB fixtures."""
import io
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

TOKEN = 'synthetic-marker_012345'


class PortableTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name).resolve()
        self.home = self.root / 'renamed-home'
        self.home.mkdir(mode=0o700)
        self.env = patch.dict(os.environ, {'HOME': str(self.home),
            'EXANGELOS_TEAMS_CONFIG': str(self.root / 'forbidden-legacy-config'),
            'EXANGELOS_TEAMS_CACHE': str(self.root / 'forbidden-legacy-cache')}, clear=True)
        self.env.start()

    def tearDown(self):
        self.env.stop()
        self.tmp.cleanup()

    def cache(self, path=None, objects=None, view=None):
        path = path or self.root / 'custom-cache'
        path.mkdir(parents=True, exist_ok=True)
        view = view if view is not None else dataset(objects if objects is not None else [message(content=TOKEN)])
        (path / 'CURRENT').write_bytes(b'MANIFEST-000001\n')
        (path / 'MANIFEST-000001').write_bytes(log(edit()))
        (path / '000003.log').write_bytes(log(batch(1, [(k, 1, v) for k, v in view.items()])))
        return path

    def configure(self, cache=None, token=TOKEN):
        request = {'selectionToken': token}
        if cache is not None:
            request['cachePath'] = str(cache)
        with patch.object(sys, 'stdin', io.TextIOWrapper(io.BytesIO(json.dumps(request).encode()))):
            return b.run('configure')

    def test_two_renamed_homes_accounts_and_native_layouts(self):
        for home, layout, origin in [('alice-renamed', 'Data/account-red/IndexedDB', sorted(b.current_store.ORIGINS)[0]),
                                      ('bob-moved', 'Data/Library/WebKit/account-blue/WebsiteData', sorted(b.current_store.ORIGINS)[1])]:
            with self.subTest(home=home), patch.dict(os.environ, {'HOME': str(self.root / home)}):
                path = Path(os.environ['HOME']) / 'Library/Containers/com.microsoft.teams2' / layout / origin
                self.cache(path)
                with patch.object(sys, 'platform', 'darwin'):
                    result = self.configure()
                self.assertEqual(result, b.run('configured-snapshot'))
                state = b.portable_path()
                self.assertTrue(state.is_relative_to(Path(os.environ['HOME'])))
                self.assertEqual(state.stat().st_mode & 0o777, 0o600)
                self.assertEqual(state.parent.stat().st_mode & 0o777, 0o700)
                self.assertNotIn(TOKEN, state.read_text())
                self.assertEqual(set(json.loads(state.read_text())), {'key', 'cache', 'scope'})

    def test_explicit_fallback_stable_key_identity_and_marker_edits(self):
        cache = self.cache()
        first = self.configure(cache)
        state = b.portable_path().read_bytes()
        self.assertEqual(first, self.configure(cache))
        self.assertEqual(state, b.portable_path().read_bytes())
        self.cache(cache, [message(content='edited marker is gone')])
        edited = b.run('configured-snapshot')
        self.assertEqual(first['scope'], edited['scope'])
        self.assertEqual(first['messages'][0]['id'], edited['messages'][0]['id'])
        self.assertNotEqual(first['messages'][0]['body'], edited['messages'][0]['body'])
        with self.assertRaises(ValueError):
            self.configure(cache)
        self.assertEqual(state, b.portable_path().read_bytes())
        self.assertFalse((self.root / 'forbidden-legacy-config').exists())

    def test_scope_change_preserves_key_but_changes_scope(self):
        cache = self.cache()
        first = self.configure(cache)
        key = json.loads(b.portable_path().read_bytes())['key']
        self.cache(cache, [message(chatId='another-account-conversation', content=TOKEN)])
        second = self.configure(cache)
        self.assertNotEqual(first['scope'], second['scope'])
        self.assertEqual(key, json.loads(b.portable_path().read_bytes())['key'])
        self.assertEqual(second, b.run('configured-snapshot'))

    def test_ambiguous_messages_scopes_databases_caches(self):
        views = [dataset([message(content=TOKEN), message('other', content=TOKEN)]),
                 dataset([message(content=TOKEN), message(chatId='other-scope', content=TOKEN)]),
                 {**dataset([message(content=TOKEN)]), **dataset([message(content=TOKEN)], db=2)}]
        for view in views:
            with self.subTest(view=len(view)), self.assertRaises(ValueError):
                self.configure(self.cache(view=view))
        one = self.cache(self.root / 'cache-one')
        two = self.cache(self.root / 'cache-two')
        with patch.object(sys, 'platform', 'darwin'), patch.object(b.current_store, 'discover', return_value=[one, two]):
            with self.assertRaises(ValueError):
                self.configure()
        self.assertFalse(b.portable_path().exists())

    def test_all_candidates_must_be_readable_and_decodable(self):
        good = self.cache(self.root / 'good')
        bad = self.cache(self.root / 'bad')
        for problem in ('missing', 'corrupt', 'unsupported'):
            if problem == 'corrupt':
                (bad / 'CURRENT').write_bytes(b'corrupt')
            if problem == 'unsupported':
                self.cache(bad, view={**dataset([message(content='other')]), b'\x00\x02\x01\x01\x01\x01\x00x': b'\x01\xff\x11\x01'})
            candidate = self.root / 'missing' if problem == 'missing' else bad
            with self.subTest(problem=problem), patch.object(sys, 'platform', 'darwin'), patch.object(b.current_store, 'discover', return_value=[good, candidate]):
                with self.assertRaises(Exception):
                    self.configure()
        self.assertFalse(b.portable_path().exists())

    def test_state_precedence_and_missing_inputs(self):
        with self.assertRaises(Exception):
            b.run('configured-snapshot')
        with patch.object(sys, 'platform', 'darwin'), self.assertRaises(ValueError):
            self.configure()
        with patch.object(sys, 'platform', 'linux'), self.assertRaises(ValueError):
            self.configure()
        cache = self.cache()
        for token in ('', 'short', 'a' * 129, 'spaces not allowed', 'é' * 12, None, 12):
            with self.subTest(token=token), self.assertRaises(ValueError):
                self.configure(cache, token)
        with patch.dict(os.environ, {'XDG_DATA_HOME': str(self.root / 'xdg')}):
            self.configure(cache)
            self.assertEqual(b.portable_path(), self.root / 'xdg/exangelos/connectors/teams/selection.json')
            with patch.dict(os.environ, {'EXANGELOS_HOME': str(self.root / 'custom-home')}):
                self.configure(cache)
                self.assertEqual(b.portable_path(), self.root / 'custom-home/connectors/teams/selection.json')

    def test_corrupt_insecure_symlink_state_never_resets_key(self):
        cache = self.cache()
        self.configure(cache)
        path = b.portable_path()
        original = path.read_bytes()
        for data in (b'', b'not json', b'{}'):
            path.write_bytes(data)
            with self.assertRaises(Exception):
                self.configure(cache)
            self.assertEqual(path.read_bytes(), data)
        path.write_bytes(original)
        path.chmod(0o644)
        with self.assertRaises(ValueError):
            self.configure(cache)
        path.chmod(0o600)
        target = path.with_name('original')
        path.rename(target)
        path.symlink_to(target)
        with self.assertRaises(OSError):
            self.configure(cache)
        self.assertEqual(target.read_bytes(), original)

    def test_installed_root_symlink_components_and_lock(self):
        cache = self.cache()
        with patch.dict(os.environ, {'EXANGELOS_HOME': str(Path(b.__file__).resolve().parents[1])}), self.assertRaises(ValueError):
            self.configure(cache)
        alias = self.root / 'alias'
        alias.symlink_to(self.home, target_is_directory=True)
        with patch.dict(os.environ, {'EXANGELOS_HOME': str(alias)}), self.assertRaises(OSError):
            self.configure(cache)
        self.configure(cache)
        path = b.portable_path()
        fd = b.portable_directory(path, False)
        try:
            b.fcntl.flock(fd, b.fcntl.LOCK_EX | b.fcntl.LOCK_NB)
            with self.assertRaises(BlockingIOError):
                self.configure(cache)
            with self.assertRaises(BlockingIOError):
                b.run('configured-snapshot')
        finally:
            os.close(fd)

    def test_cli_bounded_input_and_static_errors(self):
        cache = self.cache()
        request = json.dumps({'selectionToken': TOKEN, 'cachePath': str(cache)}).encode()
        proc = subprocess.run([sys.executable, b.__file__, 'configure'], input=request, capture_output=True, timeout=15)
        self.assertEqual((proc.returncode, proc.stderr), (0, b''))
        self.assertEqual(json.loads(proc.stdout), b.run('configured-snapshot'))
        for raw in (b'', b'{}', b'[]', b'x' * (b.MAX_CONFIG + 1)):
            proc = subprocess.run([sys.executable, b.__file__, 'configure'], input=raw, capture_output=True, timeout=15)
            self.assertEqual((proc.returncode, proc.stdout, proc.stderr), (1, b'', b'teams_bridge_unavailable\n'))

    def test_installed_directory_identity_and_external_sibling(self):
        cache = self.cache()
        installed = self.root / 'SyntheticBundle'
        (installed / 'runtime').mkdir(parents=True, mode=0o700)
        with patch.object(b, '__file__', str(installed / 'runtime/bridge.py')):
            with patch.dict(os.environ, {'EXANGELOS_HOME': str(self.root / 'external-sibling')}):
                result = self.configure(cache)
                self.assertEqual(result, b.run('configured-snapshot'))
            # Exercise descriptor identity independently of the lexical guard.
            with self.assertRaises(ValueError):
                b.portable_directory(installed / 'connectors/teams/selection.json', True)
            self.assertEqual(list(installed.iterdir()), [installed / 'runtime'])

    def test_case_insensitive_installed_alias_is_rejected_before_writes(self):
        cache = self.cache()
        installed = self.root / 'SyntheticBundle'
        (installed / 'runtime').mkdir(parents=True, mode=0o700)
        alias = self.root / 'sYNTHETICbUNDLE'
        if not alias.exists() or not alias.samefile(installed):
            self.skipTest('Filesystem is case-sensitive; descriptor identity covered separately')
        with patch.object(b, '__file__', str(installed / 'runtime/bridge.py')):
            with patch.dict(os.environ, {'EXANGELOS_HOME': str(alias)}), self.assertRaises(ValueError):
                self.configure(cache)
        self.assertEqual(list(installed.iterdir()), [installed / 'runtime'])


if __name__ == '__main__':
    unittest.main()
