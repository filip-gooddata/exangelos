import contextlib
import io
import json
import unittest
import semantics as m
from test_serialization import dataset
from test_probe import vint

A='11111111-1111-1111-1111-111111111111'
T='22222222-2222-2222-2222-222222222222'

class SemanticsTests(unittest.TestCase):
    def test_nested_and_encoded(self):
        row={'id':'0','nested':{'accountId':A,'tenantId':T},'data':json.dumps({'id':'m','conversationId':'scope','composeTime':'2026-11-13T12:00:00Z','content':'text'})}
        out=m.analyze(dataset([row]))
        self.assertEqual(out['nested_account_tenant_pairs'],1)
        self.assertEqual(out['scope_encoded_rows'],1)
        self.assertEqual(out['nested_structural_candidates'],1)
        self.assertEqual(out['message_store_structural_candidates'],0)
        self.assertFalse(out['message_semantics_proven'])

    def test_top_level_candidate_requires_key_match(self):
        row={'id':'0','conversationId':'scope','composeTime':'2026-11-13T12:00:00Z','content':'text'}
        self.assertEqual(m.analyze(dataset([row]))['message_store_structural_candidates'],1)
        row['id']='wrong'
        self.assertEqual(m.analyze(dataset([row]))['message_store_structural_candidates'],0)

    def test_partition_is_not_authority_and_sender_is_not_owner(self):
        rows=dataset([{'id':'0','sender':A,'nested':{'tenantId':T}}])
        rows[b'\0\1\0\0\1']=('cache_'+A+'_'+T).encode('utf-16-be')
        out=m.analyze(rows)
        self.assertEqual(out['db_names_with_multiple_uuid'],1)
        self.assertEqual(out['sender_partition_matches'],1)
        self.assertEqual(out['account_partition_matches'],0)
        self.assertEqual(out['partition_pair_rows'],0)
        self.assertFalse(out['account_binding_proven'])

    def test_global_metadata_partition(self):
        rows=dataset([{'id':'0','nested':{'accountId':A,'tenantId':T}}])
        def string(x): return vint(len(x))+x.encode('utf-16-be')
        rows[b'\0\0\0\0\xc9'+string('synthetic-origin')+string('cache_'+A+'_'+T)]=(1).to_bytes(1,'little')
        out=m.analyze(rows)
        self.assertEqual(out['global_db_names'],1)
        self.assertEqual(out['partition_pair_component_matches'],1)
        self.assertEqual(out['account_first_component_rows'],1)
        self.assertEqual(out['tenant_second_component_rows'],1)
        self.assertEqual(out['partition_pair_rows'],1)
        self.assertEqual(out['account_tenant_distinct_pairs'],1)
        self.assertFalse(out['account_binding_proven'])

    def test_partition_is_database_local(self):
        rows=dataset([{'id':'0','accountId':A,'tenantId':T}])
        rows[b'\0\2\0\0\1']=('cache_'+A+'_'+T).encode('utf-16-be')
        self.assertEqual(m.analyze(rows)['partition_pair_rows'],0)

    def test_strings_not_markers(self):
        out=m.analyze(dataset([{'id':'0','content':'conversationId composeTime tenantId'}]))
        self.assertEqual(out['scope_top_rows'],0)
        self.assertEqual(out['created_top_rows'],0)

    def test_cycles_and_walk_budget(self):
        obj={}; obj['self']=obj
        out=dict.fromkeys(m.COUNTERS,0)
        self.assertEqual(len(list(m._walk(obj,out))),1)
        old=m.s.MAX_NODES
        try:
            m.s.MAX_NODES=2
            list(m._walk([1,2,3],out))
            self.assertEqual(out['walk_limited'],1)
        finally: m.s.MAX_NODES=old

    def test_nested_message_relationships(self):
        nested={'id':'1794564000000','conversationId':'19:synthetic@thread.test','composeTime':'2026-11-13T10:00:00Z','content':'synthetic'}
        row={'id':'0','conversationId':'19:synthetic@thread.test','children':[nested,nested]}
        out=m.analyze(dataset([row]))
        self.assertEqual(out['candidate_scope_root_matches'],2)
        self.assertEqual(out['candidate_scoped_identities'],1)
        self.assertEqual(out['candidate_canonical_identities'],1)
        self.assertEqual(out['candidate_duplicate_scoped_identities'],1)
        self.assertEqual(out['message_shaped_with_ancestor_scope'],2)
        self.assertEqual(out['candidate_identity_time_matches'],2)

    def test_sparse_collection_traversal_cycle(self):
        sparse=m.s._SparseArray(2)
        collection=m.s._Collection('set')
        sparse.properties[1]={'id':'x'}
        sparse.properties['cycle']=collection
        collection.items.append(sparse)
        out=dict.fromkeys(m.COUNTERS,0)
        nodes=list(m._walk(sparse,out))
        self.assertEqual(len(nodes),2)
        self.assertEqual(out['sparse_containers'],1)
        self.assertEqual(out['set_containers'],1)

    def test_conflicting_partition_fails_closed(self):
        rows=dataset([{'id':'0','accountId':A,'tenantId':T}])
        def string(x): return vint(len(x))+x.encode('utf-16-be')
        rows[b'\0\0\0\0\xc9'+string('synthetic-origin')+string('cache_'+A+'_'+T)]=b'\1'
        rows[b'\0\1\0\0\1']='different'.encode('utf-16-be')
        out=m.analyze(rows)
        self.assertEqual(out['db_name_conflicts'],1)
        self.assertEqual(out['rows_with_partition_uuid'],0)

    def test_component_order_conflict_is_permutation_invariant(self):
        from itertools import permutations
        def string(x): return vint(len(x))+x.encode('utf-16-be')
        def global_name(origin, name):
            return b'\0\0\0\0\xc9'+string(origin)+string(name)
        for conflicting in (False, True):
            first='cache_'+A+'_'+T
            second='cache_'+T+'_'+A if conflicting else first
            entries=[(global_name('one', first), b'\1'),
                     (b'\0\1\0\0\1', second.encode('utf-16-be')),
                     (global_name('two', first), b'\1')]
            for ordered in permutations(entries):
                rows=dataset([{'id':'0','accountId':A,'tenantId':T,'sender':A}])
                rows.update(ordered)
                out=m.analyze(rows)
                self.assertEqual(out['db_name_conflicts'] > 0, conflicting)
                for key in ('rows_with_partition_uuid','account_partition_matches',
                            'tenant_partition_matches','sender_partition_matches',
                            'account_first_component_rows','tenant_second_component_rows',
                            'partition_pair_rows','partition_pair_component_matches'):
                    self.assertEqual(out[key],0 if conflicting else 1)
                self.assertEqual(out['account_second_component_rows'],0)
                self.assertEqual(out['tenant_first_component_rows'],0)
                self.assertFalse(out['account_binding_proven'])

    def test_fixed_output_and_rejections(self):
        rows=dataset([{'id':'0','secret-schema':'secret-content','data':'{invalid'}],category='secret-store')
        capture=io.StringIO()
        with contextlib.redirect_stdout(capture), contextlib.redirect_stderr(capture): out=m.analyze(rows)
        self.assertEqual(capture.getvalue(),'')
        self.assertEqual(set(out),set(m.analyze({})))
        self.assertTrue(all(type(x) in (int,bool) for x in out.values()))
        self.assertNotIn('secret',json.dumps(out))
        self.assertEqual(out['json_rejected'],1)
        self.assertFalse(m.analyze({1:b''})['input_bounded'])
        self.assertEqual(m.analyze({b'bad':b''})['invalid'],1)

if __name__=='__main__': unittest.main()
