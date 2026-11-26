"""Synthetic-only fixtures; custom runner emits aggregate counts, never tracebacks."""
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import current_store as s


def vi(n):
    out = bytearray()
    while n > 127:
        out.append((n & 127) | 128)
        n >>= 7
    return bytes(out) + bytes([n])


def blob(b):
    return vi(len(b)) + b


def ik(k, seq, kind=1):
    return k + ((seq << 8) | kind).to_bytes(8, 'little')


def log(*items):
    out = bytearray()
    for item in items:
        p, first = 0, True
        while first or p < len(item):
            room = 32768 - len(out) % 32768
            if room < 7:
                out.extend(bytes(room))
                room = 32768
            piece = item[p:p + room - 7]
            last = p + len(piece) == len(item)
            kind = (1 if last else 2) if first else (4 if last else 3)
            out.extend(s.masked_crc(bytes([kind]) + piece).to_bytes(4, 'little'))
            out.extend(len(piece).to_bytes(2, 'little') + bytes([kind]) + piece)
            p += len(piece)
            first = False
    return bytes(out)


def block(pairs):
    payload = b''.join(vi(0) + vi(len(k)) + vi(len(v)) + k + v for k, v in pairs)
    return payload + bytes(4) + (1).to_bytes(4, 'little')


def table(pairs):
    out = bytearray()
    def add(raw):
        h = vi(len(out)) + vi(len(raw))
        out.extend(raw + b'\0' + s.masked_crc(raw + b'\0').to_bytes(4, 'little'))
        return h
    dh = add(block(pairs))
    mh = add(block([]))
    ih = add(block([(pairs[-1][0], dh)]))
    footer = mh + ih
    return bytes(out) + footer + bytes(40 - len(footer)) + bytes.fromhex('57fb808b247547db')


def edit(table_data=None, pairs=None, comparator=b'leveldb.BytewiseComparator'):
    data = vi(1) + blob(comparator) + vi(2) + vi(3) + vi(3) + vi(10) + vi(4) + vi(10)
    if table_data is not None:
        data += vi(7) + vi(0) + vi(2) + vi(len(table_data)) + blob(pairs[0][0]) + blob(pairs[-1][0])
    return data


def batch(seq, rows):
    return seq.to_bytes(8, 'little') + len(rows).to_bytes(4, 'little') + b''.join(
        bytes([kind]) + blob(key) + (blob(value) if kind else b'') for key, kind, value in rows)


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()

        self.path = Path(self.tmp.name).resolve()

    def tearDown(self):
        self.tmp.cleanup()

    def fixture(self, pairs=None, wal=None, comparator=b'leveldb.BytewiseComparator'):
        (self.path / 'CURRENT').write_bytes(b'MANIFEST-000001\n')
        data = table(pairs) if pairs else None
        (self.path / 'MANIFEST-000001').write_bytes(log(edit(data, pairs, comparator)))
        if data:
            (self.path / '000002.ldb').write_bytes(data)
        (self.path / '000003.log').write_bytes(log(wal) if wal else b'')

    def reject(self):
        with self.assertRaises(s.Invalid) as caught:
            s.current_view(self.path)
        self.assertEqual(str(caught.exception), 'unavailable')
        self.assertIsNone(caught.exception.__context__)

    def test_empty(self):
        self.fixture()
        self.assertEqual(s.current_view(self.path)[0], {})

    def test_versions_tombstones(self):
        self.fixture([(ik(b'a', 10, 0), b''), (ik(b'a', 3), b'old'), (ik(b'b', 2), b'v')])
        view, stats = s.current_view(self.path)
        self.assertEqual(view, {b'b': b'v'})
        self.assertEqual(stats['tombstones'], 1)

    def test_wal_revival_and_delete(self):
        self.fixture([(ik(b'a', 10, 0), b''), (ik(b'b', 2), b'v')], batch(11, [(b'a', 1, b'new'), (b'b', 0, b'')]))
        self.assertEqual(s.current_view(self.path)[0], {b'a': b'new'})

    def test_obsolete_files_ignored(self):
        self.fixture()
        (self.path / '000001.log').write_bytes(b'invalid')
        (self.path / '000009.ldb').write_bytes(b'invalid')
        self.assertEqual(s.current_view(self.path)[0], {})

    def test_manifest_delete(self):
        self.fixture([(ik(b'a', 2), b'v')])
        p = self.path / 'MANIFEST-000001'
        p.write_bytes(p.read_bytes() + log(vi(6) + vi(0) + vi(2)))
        self.assertEqual(s.current_view(self.path)[0], {})

    def test_unsupported_comparator(self):
        self.fixture(comparator=b'unsupported')
        self.reject()

    def test_unknown_manifest_tag(self):
        self.fixture()
        p = self.path / 'MANIFEST-000001'
        p.write_bytes(p.read_bytes() + log(vi(100)))
        self.reject()

    def test_manifest_missing_fields(self):
        self.fixture()
        (self.path / 'MANIFEST-000001').write_bytes(log(vi(4) + vi(10)))
        self.reject()

    def test_manifest_sequence_regression(self):
        self.fixture()
        p = self.path / 'MANIFEST-000001'
        p.write_bytes(p.read_bytes() + log(vi(4) + vi(9)))
        self.reject()

    def test_missing_table(self):
        self.fixture([(ik(b'a', 2), b'v')])
        (self.path / '000002.ldb').unlink()
        self.reject()

    def test_table_crc(self):
        self.fixture([(ik(b'a', 2), b'v')])
        p = self.path / '000002.ldb'
        raw = bytearray(p.read_bytes()); raw[4] ^= 1; p.write_bytes(raw)
        self.reject()

    def test_missing_wal(self):
        self.fixture(); (self.path / '000003.log').unlink(); self.reject()

    def test_truncated_wal(self):
        self.fixture(wal=batch(11, [(b'a', 1, b'x')]))
        p = self.path / '000003.log'; p.write_bytes(p.read_bytes()[:-1]); self.reject()

    def test_bad_wal_crc(self):
        self.fixture(wal=batch(11, [(b'a', 1, b'x')]))
        p = self.path / '000003.log'; raw = bytearray(p.read_bytes()); raw[0] ^= 1; p.write_bytes(raw); self.reject()

    def test_bad_batch_count(self):
        self.fixture(wal=batch(11, []) + b'\1'); self.reject()

    def test_conflicting_sequence(self):
        self.fixture([(ik(b'a', 10), b'v')], batch(10, [(b'a', 1, b'x')]))
        self.reject()

    def test_duplicate_sequence_same_value(self):
        self.fixture([(ik(b'a', 10), b'v')], batch(10, [(b'a', 1, b'v')]))
        self.assertEqual(s.current_view(self.path)[0], {b'a': b'v'})

    def test_fragmented_log(self):
        payload = b'x' * 100000
        self.assertEqual(list(s.records(log(payload))), [payload])

    def test_unfinished_fragment(self):
        data = log(b'x' * 100000)[:32768]
        with self.assertRaises(s.Invalid): list(s.records(data))

    def test_restart_corruption(self):
        raw = block([(b'a', b'v')]); raw = raw[:-8] + (1).to_bytes(4, 'little') + raw[-4:]
        with self.assertRaises(s.Invalid): list(s.entries(raw))

    def test_snappy(self):
        self.assertEqual(s.snappy(b'\x05\x00a\x01\x01'), b'aaaaa')
        with self.assertRaises(s.Invalid): s.snappy(b'\x05\x01\x00')

    def test_current_path_escape(self):
        self.fixture(); (self.path / 'CURRENT').write_bytes(b'../MANIFEST-000001\n'); self.reject()

    def test_symlink_file(self):
        self.fixture(); (self.path / 'CURRENT').unlink(); (self.path / 'CURRENT').symlink_to('000003.log'); self.reject()

    def test_symlink_parent(self):
        self.fixture(); alias = self.path / 'alias'; alias.symlink_to(self.path, target_is_directory=True)
        with self.assertRaises(s.Invalid): s.current_view(alias)

    def test_instability(self):
        self.fixture()
        original = s.Snapshot.verify
        def changed(snapshot, names):
            (self.path / '000003.log').write_bytes(log(batch(11, [(b'a', 1, b'x')])))
            return original(snapshot, names)
        with patch.object(s.Snapshot, 'verify', changed): self.reject()

    def test_write_during_decode_is_visible_on_the_next_read(self):
        self.fixture([(ik(b'a', 3), b'old')])
        original = s.table_entries
        def append(*args):
            (self.path / '000003.log').write_bytes(log(batch(11, [(b'a', 1, b'new')])))
            return original(*args)
        with patch.object(s, 'table_entries', append):
            self.assertEqual(s.current_view(self.path)[0], {b'a': b'old'})
        self.assertEqual(s.current_view(self.path)[0], {b'a': b'new'})

    def test_compaction_after_capture_does_not_invalidate_the_read(self):
        self.fixture([(ik(b'a', 3), b'old')])
        original = s.table_entries
        def compact(*args):
            (self.path / '000002.ldb').unlink()
            self.fixture(wal=batch(11, [(b'a', 1, b'new')]))
            return original(*args)
        with patch.object(s, 'table_entries', compact):
            self.assertEqual(s.current_view(self.path)[0], {b'a': b'old'})
        self.assertEqual(s.current_view(self.path)[0], {b'a': b'new'})

    def test_limit(self):
        self.fixture()
        with patch.object(s, 'TOTAL_LIMIT', 1): self.reject()

    def test_discovery_allowlist(self):
        root = self.path / 'Library/Containers/com.microsoft.teams2'
        root.mkdir(parents=True)
        allowed = root / next(iter(s.ORIGINS)); allowed.mkdir()
        (root / 'other.indexeddb.leveldb').mkdir()
        (root / 'alias').symlink_to(allowed, target_is_directory=True)
        with patch.object(s.Path, 'home', return_value=self.path): self.assertEqual(s.discover(), [allowed])

    def test_expansion_budget(self):
        data = table([(ik(b'a', 2), b'v')])
        with patch.object(s, 'TOTAL_LIMIT', 1):
            with self.assertRaises(s.Invalid): list(s.table_entries(data))

    def test_unknown_internal_type(self):
        self.fixture([(ik(b'a', 2, 2), b'v')])
        self.reject()

    def test_manifest_size_mismatch(self):
        self.fixture([(ik(b'a', 2), b'v')])
        p = self.path / '000002.ldb'
        p.write_bytes(p.read_bytes() + b'x')
        self.reject()

    def test_previous_wal(self):
        self.fixture(wal=batch(12, [(b'a', 1, b'new')]))
        p = self.path / 'MANIFEST-000001'
        p.write_bytes(p.read_bytes() + log(vi(9) + vi(1)))
        (self.path / '000001.log').write_bytes(log(batch(11, [(b'a', 1, b'old')])))
        self.assertEqual(s.current_view(self.path)[0], {b'a': b'new'})

    def test_current_replacement(self):
        self.fixture()
        original = s.Snapshot.verify
        def changed(snapshot, names):
            p = self.path / 'CURRENT'
            data = p.read_bytes()
            p.unlink(); p.write_bytes(data)
            return original(snapshot, names)
        with patch.object(s.Snapshot, 'verify', changed): self.reject()

    def test_wal_sequence_overflow(self):
        self.fixture(wal=batch(s.SEQ_LIMIT, [(b'a', 1, b'x'), (b'b', 1, b'y')]))
        self.reject()

    def test_table_sequence_above_manifest(self):
        self.fixture([(ik(b'a', 11), b'x')])
        self.reject()

    @staticmethod
    def idb_number(value, width=1):
        import struct
        return bytes([(width - 1) << 5]) + (1).to_bytes(width, 'little') + bytes([1, 1, 3]) + struct.pack('<d', value)

    def test_idb_numeric_order(self):
        a, b = self.idb_number(-5), self.idb_number(2)
        self.fixture([(ik(a, 2), b'a'), (ik(b, 3), b'b')], comparator=b'idb_cmp1')
        self.assertEqual(s.current_view(self.path)[0], {a: b'a', b: b'b'})

    def test_idb_prefix_equivalent_delete(self):
        a, b = self.idb_number(5), self.idb_number(5, 2)
        self.fixture([(ik(a, 2), b'a')], batch(11, [(b, 0, b'')]), b'idb_cmp1')
        view, stats = s.current_view(self.path)
        self.assertEqual(view, {})
        self.assertEqual(stats['tombstones'], 1)

    def test_idb_zero_equivalent_update(self):
        a, b = self.idb_number(-0.0), self.idb_number(0.0, 2)
        self.fixture([(ik(a, 2), b'a')], batch(11, [(b, 1, b'b')]), b'idb_cmp1')
        self.assertEqual(s.current_view(self.path)[0], {b: b'b'})

    def test_idb_equivalent_sequence_conflict(self):
        a, b = self.idb_number(-0.0), self.idb_number(0.0, 2)
        self.fixture([(ik(a, 2), b'a')], batch(2, [(b, 1, b'b')]), b'idb_cmp1')
        self.reject()

    def test_idb_equivalent_sequence_duplicate(self):
        a, b = self.idb_number(-0.0), self.idb_number(0.0, 2)
        self.fixture([(ik(a, 2), b'a')], batch(2, [(b, 1, b'a')]), b'idb_cmp1')
        self.assertEqual(len(s.current_view(self.path)[0]), 1)

    def test_idb_bad_table_order(self):
        a, b = self.idb_number(2), self.idb_number(-5)
        self.fixture([(ik(a, 2), b'a'), (ik(b, 3), b'b')], comparator=b'idb_cmp1')
        self.reject()

    def test_idb_equivalent_manifest_bounds(self):
        a, b = self.idb_number(-0.0), self.idb_number(0.0, 2)
        pairs = [(ik(a, 2), b'a')]
        self.fixture(pairs, comparator=b'idb_cmp1')
        (self.path / 'MANIFEST-000001').write_bytes(log(edit(table(pairs), [(ik(b, 2), b'a')], b'idb_cmp1')))
        self.assertEqual(s.current_view(self.path)[0], {a: b'a'})

    def test_comparator_change_rejected(self):
        self.fixture()
        p = self.path / 'MANIFEST-000001'
        p.write_bytes(p.read_bytes() + log(vi(1) + blob(b'idb_cmp1')))
        self.reject()

    def test_static_aggregates(self):
        self.fixture()
        stats = s.current_view(self.path)[1]
        self.assertTrue(all(type(v) in (int, bool) for v in stats.values()))


if __name__ == '__main__':
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(StoreTests)
    result = unittest.TextTestRunner(stream=io.StringIO()).run(suite)
    print(json.dumps({'tests': result.testsRun, 'failures': len(result.failures),
                      'errors': len(result.errors), 'successful': result.wasSuccessful()}))
    raise SystemExit(not result.wasSuccessful())
