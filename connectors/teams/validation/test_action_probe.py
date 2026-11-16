import unittest
import io
import os
import tempfile
from pathlib import Path

import action_probe as a
from test_serialization import dataset


def message(identity='target', **fields):
    return {'id': identity, 'chatId': 'synthetic-scope',
            'createdTime': '2026-11-13T00:00:00Z',
            'content': 'synthetic private target body', 'version': 1, **fields}


class ActionTests(unittest.TestCase):
    def test_irrelevant_key_collisions_preserve_nested_candidates(self):
        wrapped = {'1': message(), '2': {'nested': message('second')},
                   'metadata': {'type': 'first', 'Type': 'second'}}
        snapshot = a.extract(dataset([wrapped]), 'origin', b'x' * 32, snippet='private target')
        self.assertEqual(len(snapshot.rows), 2)
        self.assertEqual(snapshot.stats['walk_gaps'], 0)
        collision = message(**{'chat-id': 'conflicting-scope'})
        rejected = a.extract(dataset([collision]), 'origin', b'x' * 32)
        self.assertEqual(rejected.stats['walk_gaps'], 1)
        self.assertFalse(rejected.rows)

    def test_private_file_is_bounded_regular_owned_and_private(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'selection'
            path.write_bytes(b'synthetic private target\n')
            path.chmod(0o600)
            self.assertEqual(a.private_file(path), 'synthetic private target')
            link = Path(directory) / 'link'
            link.symlink_to(path)
            with self.assertRaises(OSError):
                a.private_file(link)
            path.chmod(0o644)
            with self.assertRaises(ValueError):
                a.private_file(path)
            path.chmod(0o600)
            for value in (b'x' * 4099, b'x' * 1025, b'short', b' ' * 12, b'\xff' * 12):
                path.write_bytes(value)
                with self.assertRaises((ValueError, UnicodeError)):
                    a.private_file(path)
            fifo = Path(directory) / 'fifo'
            os.mkfifo(fifo, 0o600)
            with self.assertRaises(ValueError):
                a.private_file(fifo)

    def test_coordinated_controls_gate_acquisition_and_keep_scope(self):
        calls = []
        class Stream(io.BytesIO):
            def readline(self, size):
                calls.append('control')
                return super().readline(size)
        control = a.Coordinator(Stream(b'ready 0\nobserve 0\nconfirmed\nready 1\nobserve 1\nconfirmed\n'))
        def acquire(key, snippet=None, selected=None):
            calls.append(('acquire', snippet is not None, selected is not None))
            return a.extract(dataset([message()]), 'origin', key, snippet, selected)
        rows = []
        status = a.run(read_private=lambda: 'private target', acquire=acquire,
            prompt=control.prompt, wait=control.wait, clock=lambda: 0,
            output=lambda row: (calls.append('ready' if row['ready'] else 'result'), rows.append(row)))
        self.assertEqual(status, 1)
        self.assertEqual(calls[:7], ['control', ('acquire', True, False), 'ready',
            'control', ('acquire', False, True), 'control', 'result'])
        self.assertEqual(calls[7:10], ['control', ('acquire', False, True), 'ready'])
        self.assertEqual([row['stage'] for row in rows], [0, 0, 1, 1])
        self.assertTrue(all(set(row) == a.KEYS for row in rows))
        self.assertNotIn('private', repr(rows))

    def test_coordinator_rejects_eof_stale_stage_and_unbounded_input(self):
        for command in (b'', b'ready 1\n', b'x' * 100, b'abort\n'):
            with self.assertRaises(ValueError):
                a.Coordinator(io.BytesIO(command)).prompt('Next stage')
        for command in (b'', b'observe 1\n', b'abort\n'):
            control = a.Coordinator(io.BytesIO(b'ready 0\n' + command))
            control.prompt('Next stage')
            with self.assertRaises(ValueError):
                control.wait(60)

    def test_body_only_edit_is_local_and_selection_requires_unique_candidate(self):
        key = b'x' * 32
        before = a.extract(dataset([message()]), 'origin', key, snippet='private target')
        self.assertEqual(len(before.matches), 1)
        target = next(iter(before.matches))
        after = a.extract(dataset([message(content='changed body')]), 'origin', key, selected=target[0])
        result = a.compare(before, after, target)
        self.assertEqual(result['target_body_changes'], 1)
        self.assertEqual(result['target_version_changes'], 0)
        self.assertEqual(result['target_record_changes'], 0)
        self.assertNotIn('synthetic', repr(before.rows))
        ambiguous = a.extract(dataset([message(), message('second')]), 'origin', key, snippet='private target')
        self.assertEqual(len(ambiguous.matches), 2)

    def test_reply_and_reaction_changes_never_infer_removal_from_absence(self):
        key = b'x' * 32
        before = a.extract(dataset([message(reactions=[])]), 'origin', key, snippet='private target')
        target = next(iter(before.matches))
        after = a.extract(dataset([message(reactions=[{'type': 'like', 'user': 'synthetic-user'}]),
            message('reply', replyToId='target')]), 'origin', key, selected=target[0])
        changed = a.compare(before, after, target)
        self.assertEqual(changed['new_parent_matches'], 1)
        self.assertEqual(changed['target_reaction_changes'], 1)
        self.assertEqual(changed['target_body_stable'], 1)
        absent = a.extract(dataset([message()]), 'origin', key, selected=target[0])
        missing = a.compare(after, absent, target)
        self.assertEqual(missing['reaction_state_changes'], 1)
        self.assertEqual(missing['target_reaction_changes'], 0)
        self.assertEqual(missing['proven_removals'], 0)
        self.assertEqual(a.compare(after, a.Snapshot(), target)['proven_removals'], 0)

    def test_staged_run_stops_after_unobserved_action_and_never_reselects(self):
        snapshots = []
        clock = [0]
        prompts = []
        def acquire(key, snippet=None, selected=None):
            snapshots.append((snippet is not None, selected is not None))
            return a.extract(dataset([message(reactions=[])]), 'origin', key, snippet, selected)
        def wait(seconds):
            clock[0] += seconds
        out = []
        status = a.run(read_private=lambda: 'private target', acquire=acquire,
            prompt=lambda text: prompts.append(text) or 'y', wait=wait,
            clock=lambda: clock[0], output=out.append)
        self.assertEqual(status, 1)
        self.assertEqual([row['stage'] for row in out], [0, 0, 1, 1])
        self.assertEqual(out[-1]['inconclusive'], 1)
        self.assertEqual(snapshots, [(True, False), (False, True), (False, True), (False, True)])
        self.assertTrue(all(type(v) is int for row in out for v in row.values()))
        self.assertNotIn('private', repr(out))

    def test_all_requested_stages_and_reaction_round_trip_remain_observations(self):
        versions = [
            [message(reactions=[])], [message(reactions=[])],
            [message(reactions=[])], [message(reactions=[]), message('new')],
            [message(reactions=[]), message('new')],
            [message(reactions=[]), message('new'), message('reply', replyToId='target')],
            [message(reactions=[])], [message(content='edited', reactions=[])],
            [message(content='edited', reactions=[])],
            [message(content='edited', reactions=[{'type': 'like'}])],
            [message(content='edited', reactions=[{'type': 'like'}])],
            [message(content='edited', reactions=[])],
        ]
        def acquire(key, snippet=None, selected=None):
            return a.extract(dataset(versions.pop(0)), 'origin', key, snippet, selected)
        rows = []
        self.assertEqual(a.run(read_private=lambda: 'private target', acquire=acquire,
            prompt=lambda _: 'y', wait=lambda _: None, clock=lambda: 0, output=rows.append), 0)
        self.assertEqual([r['stage'] for r in rows if not r['ready']], list(range(6)))
        self.assertEqual(rows[-1]['reaction_return_to_baseline'], 1)
        self.assertEqual(rows[-1]['proven_removals'], 0)
        for row in rows:
            self.assertEqual(set(row), a.KEYS)
            self.assertEqual(row['proven_events'], 0)

    def test_incomplete_or_conflicting_observations_cannot_be_changes(self):
        key = b'x' * 32
        conflicting = a.extract(dataset([message(), message(content='conflicting'), message()]),
            'origin', key, snippet='private target')
        target = next(iter(conflicting.matches))
        self.assertFalse(a.usable(conflicting, target))
        states = [a.extract(dataset([message()]), 'origin', key, snippet='private target'), a.Snapshot()]
        states[1].stats['acquisition_gaps'] = 1
        out = []
        self.assertEqual(a.run(read_private=lambda: 'private target', acquire=lambda *args, **kwargs: states.pop(0),
            prompt=lambda _: 'y', wait=lambda _: None, clock=lambda: 0, output=out.append), 1)
        self.assertEqual(out[-1]['failed'], 1)
        self.assertEqual(out[-1]['missing_candidates'], 0)
        self.assertEqual(a.representation(key, 'reaction', {'reactions': set()})[0], 4)
        with self.assertRaises(ValueError):
            a.emit({'raw': 'synthetic private text'})

    def test_ambiguous_new_candidate_cannot_complete_send_stage(self):
        key = b'x' * 32
        before = a.extract(dataset([message()]), 'origin', key, snippet='private target')
        target = next(iter(before.matches))
        after = a.extract(dataset([message(), message('new'), message('new', content='conflicting')]),
            'origin', key, selected=target[0])
        result = a.compare(before, after, target)
        self.assertEqual(result['new_candidates'], 1)
        self.assertFalse(a.observed(1, result))

    def test_readiness_precedes_each_baseline_without_blocking_after_it(self):
        calls = []
        def acquire(key, snippet=None, selected=None):
            calls.append('acquire')
            return a.extract(dataset([message()]), 'origin', key, snippet, selected)
        def prompt(text):
            calls.append('prompt')
            return 'n'
        def output(row):
            calls.append('ready' if row['ready'] else 'result')
        a.run(read_private=lambda: 'private target', acquire=acquire, prompt=prompt,
            wait=lambda _: calls.append('wait'), clock=lambda: 0, output=output)
        self.assertEqual(calls, ['prompt', 'acquire', 'ready', 'wait', 'acquire', 'prompt', 'result'])

    def test_mixed_supported_and_conflicting_new_candidates_stop_before_next_stage(self):
        inputs = [[message()], [message()], [message()],
            [message(), message('supported'), message('conflict'), message('conflict', content='different')]]
        def acquire(key, snippet=None, selected=None):
            self.assertTrue(inputs, 'must not start another stage after ambiguous observation')
            return a.extract(dataset(inputs.pop(0)), 'origin', key, snippet, selected)
        rows = []
        status = a.run(read_private=lambda: 'private target', acquire=acquire,
            prompt=lambda _: 'y', wait=lambda _: None, clock=lambda: 0, output=rows.append)
        self.assertEqual(status, 1)
        self.assertEqual([row['stage'] for row in rows], [0, 0, 1, 1])
        self.assertEqual(rows[-1]['ambiguous'], 1)
        self.assertEqual(rows[-1]['inconclusive'], 1)
        self.assertEqual(rows[-1]['new_candidates'], 0)
