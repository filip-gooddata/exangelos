import contextlib
import io
import json
import unittest
from unittest.mock import patch
import controlled_probe as c
from test_serialization import dataset, val


def node(identity='one', scope='chat', version=1):
    return {'id': identity, 'chatId': scope, 'createdTime': '2026-11-13T00:00:00Z',
            'content': 'synthetic-private-body', 'version': version}


class ControlledTests(unittest.TestCase):
    def test_select_and_exclude_other_scope(self):
        rows, matches, out = c.extract(dataset([node(), node('two', 'other')]), 'origin', 'synthetic-private-body')
        self.assertEqual(len(matches), 2)
        selected = ('origin', 1, 'chat')
        rows, _, _ = c.extract(dataset([node(), node('two', 'other')]), 'origin', selected=selected)
        self.assertEqual(len(rows), 1)
        self.assertNotIn('synthetic-private-body', repr(rows))

    def test_conflicting_scope_not_selected(self):
        row = node(); row['threadId'] = 'other'
        rows, matches, out = c.extract(dataset([row]), 'origin', 'synthetic-private-body')
        self.assertFalse(rows or matches)
        self.assertEqual(out['ambiguous_candidates'], 1)

    def test_team_scope_alone_is_not_a_conversation(self):
        row = node(); row['teamId'] = row.pop('chatId')
        rows, matches, _ = c.extract(dataset([row]), 'origin', 'synthetic-private-body')
        self.assertFalse(rows or matches)

    def test_candidate_and_parent_version_are_separate(self):
        before, _, _ = c.extract(dataset([node()]), 'origin')
        after, _, _ = c.extract(dataset([node(version=2)]), 'origin')
        out = c.compare(before, after, c.counts())
        self.assertEqual(out['candidate_version_changes'], 1)
        self.assertEqual(out['record_version_changes'], 0)
        after = {k:(v[0], 2) for k,v in before.items()}
        out = c.compare(before, after, c.counts())
        self.assertEqual(out['candidate_version_changes'], 0)
        self.assertEqual(out['record_version_changes'], 1)

    def test_missing_is_never_deletion_and_namespace_isolation(self):
        before, _, _ = c.extract(dataset([node()]), 'first-origin')
        after, _, _ = c.extract(dataset([node()]), 'second-origin')
        out = c.compare(before, after, c.counts())
        self.assertEqual((out['missing_candidates'], out['new_candidates']), (1, 1))
        self.assertEqual(out['proven_deletions'], 0)
        self.assertEqual(out['proven_message_events'], 0)

    def test_duplicate_conflicting_version_stays_ambiguous(self):
        rows, _, out = c.extract(dataset([node(), node(version=2), node()]), 'origin')
        self.assertEqual(list(rows.values()), [None])
        self.assertEqual(out['ambiguous_candidates'], 1)

    def test_unsupported_counted_without_disclosing_error(self):
        data = dataset([node()])
        k = next(k for k in data if k[:4] == bytes((0,1,1,1)))
        data[k] = b'\1\xff\x11\1private-external'
        rows, _, out = c.extract(data, 'origin')
        self.assertFalse(rows)
        self.assertEqual(out['unsupported'], 1)
        self.assertNotIn('private', json.dumps(out))

    def test_bounded_run_output_and_private_filter(self):
        rows, matches, stats = c.extract(dataset([node()]), 'origin', 'synthetic-private-body')
        calls = []
        def acquire(**kwargs):
            calls.append(kwargs)
            return rows, set(matches), dict(stats)
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            self.assertEqual(c.run(lambda:'synthetic-private-body', acquire, lambda delay:self.assertEqual(delay,60)), 0)
        lines = list(map(json.loads, output.getvalue().splitlines()))
        self.assertEqual(len(lines), 2)
        self.assertEqual(lines[0]['ready'], 1)
        self.assertEqual(lines[1]['unchanged_candidates'], 1)
        self.assertEqual(set(lines[0]), set(c.KEYS))
        self.assertNotIn('snippet', calls[1])
        for private in ('synthetic-private-body', 'origin', 'chat'):
            self.assertNotIn(private, output.getvalue())

    def test_failed_second_acquisition_does_not_compare(self):
        rows, matches, stats = c.extract(dataset([node()]), 'origin', 'synthetic-private-body')
        bad = c.counts(); bad['acquisition_gaps'] = 1
        with patch.object(c, 'observe', side_effect=[]) as unused:
            acquire = iter([(rows, matches, stats), ({},set(),bad)])
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                result = c.run(lambda:'synthetic-private-body', lambda **kw:next(acquire), lambda _:None)
        self.assertEqual(result, 1)
        last = json.loads(output.getvalue().splitlines()[-1])
        self.assertEqual(last['missing_candidates'], 0)
        self.assertEqual(last['failed'], 1)

    def test_main_suppresses_exception_and_argument_text(self):
        for args in (['probe'], ['probe', 'synthetic-private-argument']):
            output = io.StringIO()
            with patch.object(c.sys, 'argv', args), patch.object(c, 'run', side_effect=ValueError('synthetic-private-error')), contextlib.redirect_stdout(output):
                self.assertEqual(c.main(), 1)
            self.assertNotIn('synthetic-private', output.getvalue())
            self.assertEqual(json.loads(output.getvalue())['failed'], 1)

    def test_output_schema_rejects_dynamic_keys_and_values(self):
        out = c.counts(); out['candidates'] = 'synthetic-private'
        with self.assertRaises(ValueError): c.emit(out)
        out = c.counts(); out['synthetic-private'] = 1
        with self.assertRaises(ValueError): c.emit(out)

    def test_ambiguous_selection_stops_before_wait(self):
        out = c.counts()
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            result = c.run(lambda:'synthetic-private', lambda **kw:({}, {('a',1,'x'),('a',2,'x')},out), lambda _:self.fail())
        self.assertEqual(result, 1)
        self.assertEqual(json.loads(output.getvalue())['ready'], 0)
