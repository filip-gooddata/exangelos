import copy
import json
import os
import pty
import select
import struct
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from test_source import database, framed
from test_direct import fixture, SELECTION, encode, uint


class SelectionTests(unittest.TestCase):
    def invoke(self, root, output, snippet='fixture body', extra=()):
        return subprocess.run([sys.executable, str(Path(__file__).with_name('private_selection.py')),
                               '--root', str(root), '--output', str(output), *extra],
                              input=snippet, text=True, capture_output=True)

    def test_private_request_is_usable_and_exclusively_created(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            database(root)
            output = root / 'request.json'
            result = self.invoke(root, output)
            self.assertEqual((result.returncode, result.stdout, result.stderr), (0, '', ''))
            value = json.loads(output.read_text())
            self.assertEqual(value['selection'], {'workspace': 'T0000001', 'owner': 'U0000001',
                                                   'conversations': ['C0000001']})
            self.assertRegex(value['key'], r'^[a-f0-9]{64}$')
            self.assertEqual(stat.S_IMODE(output.stat().st_mode), 0o600)
            import source
            self.assertTrue(source.acquire(value)['complete'])
            original = output.read_bytes()
            again = self.invoke(root, output)
            self.assertEqual((again.returncode, again.stdout, again.stderr),
                             (1, '', 'Slack private selection unavailable.\n'))
            self.assertEqual(output.read_bytes(), original)


    def test_repeated_literal_matches_in_one_conversation_are_accepted(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            state = fixture()
            messages = state['messages'][SELECTION[2]]
            message = copy.deepcopy(next(iter(messages.values())))
            message.update(ts='1700000001.000001', _rxn_key='message-1700000001.000001-C0000001')
            messages[message['ts']] = message
            database(root, state)
            first, second = root / 'first.json', root / 'second.json'
            for output in (first, second):
                result = self.invoke(root, output, 'xture bod')
                self.assertEqual((result.returncode, result.stdout, result.stderr), (0, '', ''))
            self.assertNotEqual(json.loads(first.read_text())['key'], json.loads(second.read_text())['key'])

    def test_failures_are_generic_and_leave_no_request(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            for case in ('absent', 'empty', 'case', 'regex', 'ambiguous', 'incomplete', 'arguments', 'oversize'):
                with self.subTest(case=case):
                    state = fixture()
                    snippet = 'fixture body'
                    extra = ()
                    if case == 'absent': snippet = 'private absent snippet'
                    if case == 'empty': snippet = ''
                    if case == 'case': snippet = 'FIXTURE BODY'
                    if case == 'regex': snippet = 'fixture.*body'
                    if case == 'oversize': snippet = 'x' * 65537
                    if case == 'arguments': extra = ('--snippet', 'private argument value')
                    if case == 'ambiguous':
                        state['messages']['C0000002'] = copy.deepcopy(state['messages'][SELECTION[2]])
                        for message in state['messages']['C0000002'].values():
                            message['_rxn_key'] = 'message-' + message['ts'] + '-C0000002'
                    if case == 'incomplete':
                        next(iter(state['messages'][SELECTION[2]].values()))['_hidden_stub'] = True
                    database(root, state)
                    output = root / 'request.json'
                    result = self.invoke(root, output, snippet, extra)
                    self.assertEqual((result.returncode, result.stdout, result.stderr),
                                     (1, '', 'Slack private selection unavailable.\n'))
                    self.assertFalse(output.exists())

    def test_redirected_file_is_literal_and_symlink_output_is_not_followed(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            database(root)
            snippet = root / 'snippet.txt'
            snippet.write_text('fixture body')
            output = root / 'request.json'
            with snippet.open() as handle:
                result = subprocess.run([sys.executable, str(Path(__file__).with_name('private_selection.py')),
                                         '--root', str(root), '--output', str(output)],
                                        stdin=handle, text=True, capture_output=True)
            self.assertEqual((result.returncode, result.stdout, result.stderr), (0, '', ''))
            target = root / 'existing.txt'
            target.write_text('preserve')
            output.unlink()
            output.symlink_to(target)
            result = self.invoke(root, output)
            self.assertEqual((result.returncode, result.stdout, result.stderr),
                             (1, '', 'Slack private selection unavailable.\n'))
            self.assertEqual(target.read_text(), 'preserve')

    def test_same_text_in_another_owner_or_workspace_is_ambiguous(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            for workspace, owner in [('T0000002', 'U0000001'), ('T0000001', 'U0000002')]:
                with self.subTest(workspace=workspace, owner=owner):
                    database(root)
                    state = fixture()
                    state['bootData']['user_id'] = owner
                    state['selfTeamIds'] = {'teamId': workspace, 'defaultWorkspaceId': workspace}
                    blob = b'\xff\x12\xff\x10' + encode(state)
                    (root / 'https_app.slack.com_0.indexeddb.blob/1/00/2').write_bytes(blob)
                    name = 'persist:slack-fixture-' + workspace + '-' + owner
                    suffix = b'\x01' + uint(len(name)) + name.encode('utf-16-be')
                    rows = [(b'\x00\x01\x01\x01' + suffix, b'\x00\xff\x11\x01' + uint(len(blob)) + b'\x00'),
                            (b'\x00\x01\x01\x03' + suffix, b'\x00\x02\x00' + uint(len(blob)))]
                    data = struct.pack('<QI', 20, len(rows))
                    data += b''.join(b'\x01' + uint(len(k)) + k + uint(len(v)) + v for k, v in rows)
                    with (root / 'https_app.slack.com_0.indexeddb.leveldb/000002.log').open('ab') as handle:
                        handle.write(framed(data))
                    output = root / 'request.json'
                    result = self.invoke(root, output)
                    self.assertEqual((result.returncode, result.stdout, result.stderr),
                                     (1, '', 'Slack private selection unavailable.\n'))
                    self.assertFalse(output.exists())

    def test_terminal_prompt_hides_snippet(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            database(root)
            output = root / 'request.json'
            master, slave = pty.openpty()
            try:
                with subprocess.Popen([sys.executable, str(Path(__file__).with_name('private_selection.py')),
                                       '--root', str(root), '--output', str(output)], stdin=slave,
                                      stdout=subprocess.PIPE, stderr=slave) as process:
                    self.assertTrue(select.select([master], [], [], 5)[0])
                    prompt = os.read(master, 4096)
                    self.assertIn(b'Cached message snippet (hidden): ', prompt)
                    os.write(master, b'fixture body\n')
                    stdout, _ = process.communicate(timeout=5)
                    self.assertEqual((process.returncode, stdout), (0, b''))
                    remaining = os.read(master, 4096) if select.select([master], [], [], 1)[0] else b''
                    self.assertNotIn(b'fixture body', prompt + remaining)
                    self.assertTrue(output.exists())
            finally:
                os.close(master)
                os.close(slave)


if __name__ == '__main__':
    unittest.main()
