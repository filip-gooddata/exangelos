"""Synthetic native reaction membership fixtures; no cache or UI access."""
import unittest

from reactions import members


class ReactionTests(unittest.TestCase):
    def test_absent_properties_unknown_but_absent_emotions_empty(self):
        self.assertIsNone(members({}))
        self.assertEqual(members({'properties': {}}), [])
        self.assertEqual(members({'properties': {'emotions': []}}), [])
        for properties in (None, [], '', 1, True):
            with self.subTest(properties=properties):
                self.assertIsNone(members({'properties': properties}))

    def test_membership_order_and_timestamps_do_not_change_identity(self):
        first = [{'key': 'like', 'users': [{'mri': 'synthetic-b', 'value': 1},
                                         {'mri': 'synthetic-a', 'value': 2}]},
                 {'key': 'heart', 'users': [{'mri': 'synthetic-a', 'value': 3}]}]
        second = [{'key': 'heart', 'users': [{'mri': 'synthetic-a', 'value': 99}]},
                  {'key': 'like', 'users': [{'mri': 'synthetic-a'},
                                          {'mri': 'synthetic-b', 'value': 'synthetic-time'}]}]
        expected = [('heart', 'synthetic-a'), ('like', 'synthetic-a'), ('like', 'synthetic-b')]
        self.assertEqual(members({'properties': {'emotions': first}}), expected)
        self.assertEqual(members({'properties': {'emotions': second}}), expected)

    def test_empty_users_are_empty_membership(self):
        self.assertEqual(members({'properties': {'emotions': [{'key': 'like', 'users': []}]}}), [])

    def test_malformed_emotions_keys_users_and_mri_are_unknown(self):
        malformed = [None, {}, '', True, [None], [[]], [{}]]
        for key in (None, '', 1, True, []):
            malformed.append([{'key': key, 'users': []}])
        for users in (None, {}, '', True, [None], ['synthetic-a'], [{}]):
            malformed.append([{'key': 'like', 'users': users}])
        malformed.append([{'key': 'like'}])
        for mri in (None, '', 1, True, []):
            malformed.append([{'key': 'like', 'users': [{'mri': mri}]}])
        for emotions in malformed:
            with self.subTest(emotions=emotions):
                self.assertIsNone(members({'properties': {'emotions': emotions}}))

    def test_one_malformed_member_invalidates_the_whole_observation(self):
        self.assertIsNone(members({'properties': {'emotions': [
            {'key': 'like', 'users': [{'mri': 'synthetic-a'}, {}]}]}}))

    def test_duplicate_memberships_within_and_across_groups_are_unknown(self):
        user = {'mri': 'synthetic-a'}
        for emotions in ([{'key': 'like', 'users': [user, {**user, 'value': 10}]}],
                         [{'key': 'like', 'users': [user]}, {'key': 'like', 'users': [user]}]):
            with self.subTest(emotions=emotions):
                self.assertIsNone(members({'properties': {'emotions': emotions}}))

    def test_membership_and_representation_bounds(self):
        users = [{'mri': f'synthetic-{i}'} for i in range(500)]
        self.assertEqual(len(members({'properties': {'emotions': [{'key': 'like', 'users': users}]}})), 500)
        for emotions in ([{'key': 'like', 'users': users + [{'mri': 'synthetic-extra'}]}],
                         [{'key': 'like', 'users': users}, {'key': 'heart', 'users': users[:1]}],
                         [{'key': str(i), 'users': []} for i in range(257)],
                         [{'key': 'like', 'users': [{'mri': 'x' * 4093}]}]):
            with self.subTest(groups=len(emotions)):
                self.assertIsNone(members({'properties': {'emotions': emotions}}))


if __name__ == '__main__':
    unittest.main()
