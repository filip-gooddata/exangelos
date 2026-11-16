"""Synthetic quoted-reply regressions; no live acquisition or private input."""
import unittest
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "runtime"))
import bridge

import action_probe as a
from test_action_probe import message
from test_serialization import dataset


def quote(parent='target', text='quoted text', **attrs):
    attributes = {'itemscope': '', 'itemtype': 'http://schema.skype.com/Reply',
                  'itemid': parent, **attrs}
    return '<blockquote ' + ' '.join(f'{k}="{v}"' for k, v in attributes.items()) + '>' + text + '</blockquote>reply'


class QuoteTests(unittest.TestCase):
    def setUp(self):
        self.key = b'x' * 32
        self.before = a.extract(dataset([message()]), 'origin', self.key, snippet='private target')
        self.target = next(iter(self.before.matches))

    def after(self, *messages):
        return a.extract(dataset([message(), *messages]), 'origin', self.key)

    def test_native_quote_produces_parent_match_without_direct_field(self):
        after = self.after(message('reply', content=quote()))
        self.assertFalse(any(after.stats.values()))
        result = a.compare(self.before, after, self.target)
        self.assertEqual(result['new_parent_matches'], 1)
        self.assertEqual(result['proven_events'], 0)
        self.assertNotIn('quoted text', repr(after))

    def test_native_self_parent_default_does_not_conflict_with_quote(self):
        rows = [message(parentMessageId='target'),
                message('reply', parentMessageId='reply', content=quote())]
        after = a.extract(dataset(rows), 'origin', self.key)
        self.assertFalse(any(after.stats.values()))
        self.assertFalse(after.rows[self.target][0][3])
        self.assertEqual(a.compare(self.before, after, self.target)['new_parent_matches'], 1)
        self.assertEqual(len(bridge.envelope(dataset(rows), 'origin', self.key, self.target[0])['messages']), 2)


    def test_quoted_snippet_still_requires_unique_selection(self):
        selected = a.extract(dataset([message(), message('reply', content=quote(text='private target'))]),
                             'origin', self.key, snippet='private target')
        self.assertEqual(len(selected.matches), 2)

    def test_text_plain_quotes_other_types_and_script_do_not_infer_parent(self):
        for body in ('target', '<blockquote itemid="target">text</blockquote>',
                     quote(itemtype='other'), '&lt;blockquote itemid="target"&gt;',
                     '<script>' + quote() + '</script>'):
            with self.subTest(body=body):
                after = self.after(message('reply', content=body))
                self.assertEqual(a.compare(self.before, after, self.target)['new_parent_matches'], 0)

    def test_html_attribute_entities_are_decoded_once(self):
        refs = a.parent_references({'content': quote('a&amp;b')}, self.key)
        self.assertEqual(refs, frozenset([a.fingerprint(self.key, 'identity', 'a&b')]))
        refs = a.parent_references({'content': quote('a&amp;amp;b')}, self.key)
        self.assertEqual(refs, frozenset([a.fingerprint(self.key, 'identity', 'a&amp;b')]))

    def test_conflicting_and_malformed_references_fail_closed(self):
        bad = [message('reply', content=quote(), replyToId='other'),
               message('reply', content=quote()+quote('other')),
               message('reply', content=quote().replace('itemid="target"', 'itemid="target" itemid="other"')),
               message('reply', content=quote('')),
               message('reply', content=quote().replace('itemscope=""', '')),
               message('reply', content=quote().replace('</blockquote>', '')),
               message('reply', content=quote().replace('>quoted text</blockquote>', '/>')),
               message('reply', replyToId=True), message('reply', replyToId={})]
        for row in bad:
            with self.subTest(row=row):
                after = self.after(row)
                self.assertGreater(after.stats['invalid'], 0)
                self.assertEqual(a.compare(self.before, after, self.target)['new_parent_matches'], 0)

    def test_matching_sources_deduplicate_and_empty_direct_fields_are_absent(self):
        after = self.after(message('reply', content=quote()+quote(), body=quote(), replyToId='target', parentMessageId=None))
        self.assertFalse(any(after.stats.values()))
        self.assertEqual(a.compare(self.before, after, self.target)['new_parent_matches'], 1)
        self.assertFalse(a.parent_references({'replytoid': '', 'parentmessageid': None}, self.key))

    def test_parent_identity_in_other_scope_is_not_a_match(self):
        after = self.after(message('reply', content=quote(), chatId='different-scope'))
        self.assertEqual(a.compare(self.before, after, self.target)['new_parent_matches'], 0)

    def test_bounds_fail_closed(self):
        for body in ('x'*65537, '<b></b>'*4097, '<blockquote>'*33 + quote()):
            after = self.after(message('reply', content=body))
            self.assertGreater(after.stats['invalid'], 0)

    def test_runtime_rejects_malformed_quote_in_other_conversation_of_selected_database(self):
        malformed = message('other', chatId='different-scope', content=quote(''))
        view = dataset([message(), malformed])
        with self.assertRaises(ValueError):
            bridge.envelope(view, 'origin', self.key, self.target[0])
        view = dataset([message()])
        view.update(dataset([malformed], db=2))
        self.assertEqual(len(bridge.envelope(view, 'origin', self.key, self.target[0])['messages']), 1)

    def test_runtime_returns_matching_opaque_parent_for_quote(self):
        view = dataset([message(), message('reply', content=quote())])
        result = bridge.envelope(view, 'origin', self.key, self.target[0])
        parents = [row['parent'] for row in result['messages'] if row['parent'] is not None]
        self.assertEqual(parents, [self.target[1].hex()])


    def test_duplicate_identity_conflicts_remain_unusable(self):
        after = self.after(message('reply', content=quote()), message('reply', content='different'))
        self.assertGreater(after.stats['ambiguous'], 0)
        self.assertEqual(a.compare(self.before, after, self.target)['new_parent_matches'], 0)


if __name__ == '__main__':
    unittest.main()
