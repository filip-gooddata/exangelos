import contextlib
import io
import json
import struct
import unittest
import serialization as s
from test_probe import vint


def enc(obj):
    if obj is None: return b'0'
    if obj is True: return b'T'
    if obj is False: return b'F'
    if type(obj) is str:
        b = obj.encode('utf-8'); return b'S'+vint(len(b))+b
    if type(obj) is int: return b'I'+vint((obj<<1) ^ (obj>>31))
    if type(obj) is float: return b'N'+struct.pack('<d',obj)
    if type(obj) is list: return b'A'+vint(len(obj))+b''.join(map(enc,obj))+b'$\0'+vint(len(obj))
    if type(obj) is dict: return b'o'+b''.join(enc(k)+enc(v) for k,v in obj.items())+b'{'+vint(len(obj))
    raise ValueError('fixture_type')


def val(obj): return b'\1\xff\x15\xfe'+bytes(12)+b'\xff\x0f'+enc(obj)
def key(x): return b'\1'+vint(len(x))+x.encode('utf-16-be')
def dataset(objects, category='messages', path='id', db=1):
    prefix = bytes((0,db,0,0,50,1))
    out = {prefix+b'\0':category.encode('utf-16-be'), prefix+b'\1':b'\0\0\1'+vint(len(path))+path.encode('utf-16-be')}
    for i,obj in enumerate(objects):
        out[bytes((0,db,1,1))+key(str(i))] = val(obj)
    return out


class SerializationTests(unittest.TestCase):
    def test_nested_blink_values(self):
        obj = {'id':'private','nested':[True,None,-2,{'x':'ž'}]}
        self.assertEqual(s._decode(val(obj)),obj)

    def test_v8_version_sixteen(self):
        self.assertEqual(s._decode(val({'id':'x'}).replace(b'\xff\x0f',b'\xff\x10')),{'id':'x'})

    def test_identity_uses_declared_keypath(self):
        result = s.analyze(dataset([{'id':'0'},{'id':'wrong'}]))
        self.assertEqual((result['keypath_matches'],result['keypath_mismatches']),(1,1))

    def test_reference_cycle(self):
        obj = s._decode(b'\1\xff\x0foS\x01x^\0{\1')
        self.assertIs(obj['x'],obj)
        result = s.analyze(dataset([{'id':'0'}]))
        self.assertEqual(result['decoded'],1)

    def test_account_consistency_is_not_login_binding(self):
        rows = [{'id':str(i),'accountId':'private-account','tenantId':'private-tenant'} for i in range(2)]
        result = s.analyze(dataset(rows))
        self.assertEqual(result['account_consistent_rows'],2)
        self.assertFalse(result['account_binding_proven'])
        rows[1]['tenantId'] = 'other-tenant'
        result = s.analyze(dataset(rows))
        self.assertEqual(result['account_conflicting_rows'],2)

    def test_binding_requires_both_trusted_components(self):
        obj = {'accountId':'account','tenantId':'tenant'}
        self.assertTrue(s._bind_account(obj,'account','tenant'))
        self.assertFalse(s._bind_account(obj,'account','other'))
        self.assertFalse(s._bind_account(obj,'other','tenant'))
        self.assertFalse(s._bind_account(obj,None,'tenant'))
        self.assertFalse(s._bind_account({'accountId':'account'},'account','tenant'))

    def test_account_scope_separated_by_database(self):
        a = dataset([{'id':'0','accountId':'a','tenantId':'t'}],db=1)
        a.update(dataset([{'id':'0','accountId':'b','tenantId':'t'}],db=2))
        self.assertEqual(s.analyze(a)['account_conflicting_rows'],0)

    def test_markers_inside_content_do_not_count(self):
        result = s.analyze(dataset([{'id':'0','content':'accountId tenantId conversationId createdTime messageId'}]))
        self.assertEqual(result['account_pairs'],0)
        self.assertEqual(result['scope_fields'],0)
        self.assertEqual(result['timestamp_shaped'],0)

    def test_timestamp_validation(self):
        self.assertTrue(s._timestamp('2026-11-13T00:00:00Z'))
        for x in (True,'yesterday',-1,float('nan'),'2026-11-13'):
            self.assertFalse(s._timestamp(x))

    def test_external_coverage(self):
        rows = dataset([{'id':'0'}])
        rows[b'\0\1\1\1'+key('0')] = b'\1\xff\x11\x01\0\0'
        rows[b'\0\1\1\3'+key('0')] = b'private-external'
        result = s.analyze(rows)
        self.assertEqual(result['external_values'],1)
        self.assertEqual(result['external_entries'],1)
        self.assertFalse(result['external_objects_supported'])

    def test_compressed_envelope(self):
        raw = val({'id':'x'})[1:]
        packed = vint(len(raw))+bytes(((len(raw)-1)<<2,))+raw
        self.assertEqual(s._decode(b'\1\xff\x11\x02'+packed),{'id':'x'})

    def test_all_truncations_rejected(self):
        value = val({'id':'private','nested':[1,2]})
        for n in range(len(value)):
            with self.assertRaises(s.Invalid): s._decode(value[:n])

    def test_malformed_limits(self):
        for raw in (b'\1\xff\x0f^\1', b'\1\xff\x0fo{\1', b'\1\xff\x0fS'+vint(s.MAX_BYTES+1),
                    b'\1\xff\x0f'+b'A\1'*70+b'0', b'\1\xff\x0f'+enc(1)+b'junk', b'\x80'*11):
            with self.assertRaises(s.Invalid): s._decode(raw)
        self.assertFalse(s.analyze({1:b'private'})['input_bounded'])

    def test_output_redaction_static_schema(self):
        raw = dataset([{'id':'0','private-schema':'private-value','accountId':'private-id','tenantId':'private-tenant'}],category='private-store')
        output = io.StringIO()
        with contextlib.redirect_stdout(output),contextlib.redirect_stderr(output):
            result = s.analyze(raw)
        self.assertEqual(output.getvalue(),'')
        self.assertNotIn('private',json.dumps(result))
        self.assertEqual(set(result),set(s.analyze({})))
        self.assertTrue(all(type(x) in (int,bool) for x in result.values()))

    def test_compound_keypath_and_nested_field(self):
        obj = {'owner':{'id':'a'}, 'id':'b'}
        self.assertEqual(s._at(obj,['owner.id','id']),['a','b'])
        self.assertTrue(s._equal(['a','b'],s._at(obj,['owner.id','id'])))
        self.assertFalse(s._equal(True,1))

class UnsupportedCoverageTests(unittest.TestCase):
    def decode(self, payload):
        return s._decode(b'\1\xff\x0f'+payload)

    def test_native_v8_synthetic_structures(self):
        import shutil
        import subprocess
        if not shutil.which('node'):
            self.skipTest('synthetic_v8_runtime_unavailable')
        script = """const v8 = require('node:v8');
const a = new Array(3); a[1] = 'synthetic'; a.self = a;
const m = new Map(); m.set({}, m);
const t = new Set(); t.add({}); t.add(t);
process.stdout.write(JSON.stringify([a,m,t].map(x => v8.serialize(x).toString('hex'))));"""
        output = subprocess.check_output(['node', '-e', script], stderr=subprocess.DEVNULL, timeout=10)
        a,m,t = [s._decode(b'\1'+bytes.fromhex(x)) for x in json.loads(output)]
        self.assertEqual(a.length, 3)
        self.assertEqual(a.properties[1], 'synthetic')
        self.assertIs(a.properties['self'], a)
        self.assertEqual(m.kind, 'map')
        self.assertEqual(m.items[0][0], {})
        self.assertIs(m.items[0][1], m)
        self.assertEqual(t.kind, 'set')
        self.assertEqual(t.items[0], {})
        self.assertIs(t.items[1], t)

    def test_sparse_holes_properties_and_cycle(self):
        obj = self.decode(b'a\3U\1'+enc('value')+enc('self')+b'^\0@\2\3')
        self.assertIsInstance(obj, s._SparseArray)
        self.assertEqual(obj.length, 3)
        self.assertNotIn(0, obj.properties)
        self.assertEqual(obj.properties[1], 'value')
        self.assertIs(obj.properties['self'], obj)

    def test_sparse_canonical_string_index(self):
        obj = self.decode(b'a\2'+enc('1')+b'T'+enc('01')+b'F@\2\2')
        self.assertEqual(obj.properties, {1:True, '01':False})

    def test_sparse_invalid_indices_counts_and_lengths(self):
        for payload in (b'a\1U\1T@\1\1', b'a\1@\1\1', b'a\1@\0\2',
                        b'a\1U\0T'+enc('0')+b'F@\2\1',
                        b'a\1'+enc('length')+b'U\1@\1\1',
                        b'a'+vint(s.MAX_NODES+1)+b'@\0'+vint(s.MAX_NODES+1)):
            with self.assertRaises(s.Invalid): self.decode(payload)

    def test_map_object_keys_and_cycle(self):
        obj = self.decode(b';o{\0^\0:\2')
        self.assertEqual(obj.kind, 'map')
        self.assertEqual(obj.items[0][0], {})
        self.assertIs(obj.items[0][1], obj)

    def test_set_unhashable_and_cycle(self):
        obj = self.decode(b"'o{\0^\0,\2")
        self.assertEqual(obj.kind, 'set')
        self.assertEqual(obj.items[0], {})
        self.assertIs(obj.items[1], obj)

    def test_new_container_reference_order(self):
        obj = self.decode(b"A\3a\0@\0\0'\x5e\1,\1^\2$\0\3")
        self.assertIs(obj[1].items[0], obj[0])
        self.assertIs(obj[2], obj[1])

    def test_collection_counts_and_truncation(self):
        for payload in (b';T:\1', b';TF:\1', b"'T,\0"):
            with self.assertRaises(s.Invalid): self.decode(payload)
        for payload in (b'a\2U\0T@\1\2', b';TF:\2', b"'T,\1"):
            for n in range(len(payload)):
                with self.assertRaises(s.Invalid): self.decode(payload[:n])
            self.decode(payload)

    def test_new_container_depth_and_node_bounds(self):
        from unittest.mock import patch
        with patch.object(s, 'MAX_NODES', 4):
            with self.assertRaises(s.Invalid): self.decode(b"'TTTT,\4")
        for begin in (b'a\1U\0', b';T', b"'"):
            with self.assertRaises(s.Invalid): self.decode(begin*70+b'T')

    def test_no_message_semantic_coercion(self):
        for payload in (b'a\0@\0\0', b';:\0', b"',\0"):
            rows = dataset([{}])
            rows[b'\0\1\1\1'+key('0')] = b'\1\xff\x0f'+payload
            out = s.analyze(rows)
            self.assertEqual(out['decoded'], 1)
            self.assertEqual(out['objects'], 0)
            self.assertFalse(out['message_semantics_proven'])

    def test_failure_reason_schema_and_external_boundary(self):
        cases = ((b'\1\xff\x11\1', 'external_envelope'),
                 (b'\1\xff\x0f'+bytes([92]), 'host_object'),
                 (b'\1\xff\x15\xfe'+bytes([1])+bytes(11), 'blink_trailer'),
                 (b'\1\xff\x0fZ', 'bigint'), (b'\1\xff\x0fB', 'array_buffer'),
                 (b'\1\xff\x0f!', 'unknown_tag'))
        for raw, reason in cases:
            rows = dataset([{}])
            rows[b'\0\1\1\1'+key('0')] = raw
            out = s.analyze(rows)
            self.assertEqual(out['failure_'+reason], 1)
            self.assertEqual(set(out), set(s.analyze({})))
            self.assertFalse(out['external_objects_supported'])
        self.assertEqual(s.Unsupported('private-name').reason, 'unknown_tag')

    def test_historical_coverage_counts_each_version_no_reconciliation(self):
        from probe import historical_serialization
        k = b'\0\1\1\1'+key('private-id')
        records = [(k+b'\1'+bytes(7), val({'private-key':'private-value'})),
                   (k+b'\1'+bytes(7), b'\1\xff\x0fa\0@\0\0'),
                   (k+b'\1'+bytes(7), b'\1\xff\x11\1'),
                   (k+b'\1'+bytes(7), b'\1\xff\x0fZ'),
                   (k+b'\1'+bytes(7), b'bad'), (k+bytes(8), b'')]
        output = io.StringIO()
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
            result = historical_serialization(records)
        self.assertEqual(output.getvalue(), '')
        self.assertEqual(result['historical_rows'], 5)
        self.assertEqual(result['historical_decoded'], 2)
        self.assertEqual(result['historical_external_values'], 1)
        self.assertEqual(result['historical_unsupported'], 1)
        self.assertEqual(result['historical_invalid'], 1)
        self.assertNotIn('private', json.dumps(result))
        self.assertEqual(set(result), set(historical_serialization([])))
        self.assertTrue(all(type(v) is int for v in result.values()))

if __name__ == '__main__': unittest.main()
