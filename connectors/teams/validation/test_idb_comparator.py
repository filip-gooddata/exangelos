"""Synthetic-only regression vectors derived from public Chromium source."""
import math
import struct
import unittest

from idb_comparator import canonical_key


def vi(value):
    value &= (1 << 64) - 1
    out = bytearray()
    while value >= 128:
        out.append((value & 127) | 128)
        value >>= 7
    out.append(value)
    return bytes(out)


def prefix(database=1, store=1, index=1, widths=(1, 1, 1)):
    a, b, c = widths
    return bytes([((a - 1) << 5) | ((b - 1) << 2) | (c - 1)]) + b''.join(
        value.to_bytes(width, 'little')
        for value, width in zip((database, store, index), widths))


def string(value):
    raw = value.encode('utf-16-be', errors='surrogatepass')
    return vi(len(raw) // 2) + raw


def number(value, kind=3):
    return bytes([kind]) + struct.pack('<d', value)


def array(*items):
    return b'\x04' + vi(len(items)) + b''.join(items)


class ComparatorTests(unittest.TestCase):
    def equal(self, *keys):
        forms = [canonical_key(key) for key in keys]
        self.assertTrue(all(form == forms[0] for form in forms))
        self.assertEqual(len(set(forms)), 1)
        self.assertEqual(len({hash(form) for form in forms}), 1)

    def ordered(self, *keys):
        forms = [canonical_key(key) for key in keys]
        self.assertTrue(all(a < b for a, b in zip(forms, forms[1:])))

    def reject(self, *keys):
        for key in keys:
            with self.assertRaises(ValueError) as result:
                canonical_key(key)
            self.assertEqual(str(result.exception), 'Unsupported or malformed IndexedDB key')
            self.assertIsNone(result.exception.__context__)

    def test_prefix_width_equivalence(self):
        self.equal(*(prefix(widths=(a, b, c)) + number(2)
                     for a in range(1, 9) for b in range(1, 9)
                     for c in range(1, 5)))

    def test_prefix_numeric_order(self):
        self.ordered(prefix(255, 1, 1) + number(0),
                     prefix(256, 1, 1, (2, 1, 1)) + number(0),
                     prefix(256, 2, 1, (2, 1, 1)) + number(0),
                     prefix(256, 2, 2, (2, 1, 1)) + number(0))

    def test_signed_zero(self):
        for kind in (2, 3):
            self.equal(prefix() + number(-0.0, kind), prefix() + number(0.0, kind))

    def test_numeric_order(self):
        self.ordered(*(prefix() + number(x) for x in (-math.inf, -2, 0, 2, math.inf)))

    def test_type_order(self):
        self.ordered(*(prefix() + key for key in (
            b'\x05', number(0), number(0, 2), b'\x01' + string(''),
            b'\x06\x00', array(), b'\x00')))

    def test_string_code_units(self):
        self.ordered(*(prefix() + b'\x01' + string(x)
                       for x in ('', 'a', 'aa', 'b', '\ud800', '\U00010000', '\ue000')))

    def test_binary_order(self):
        self.ordered(*(prefix() + b'\x06' + vi(len(x)) + x
                       for x in (b'', b'\x00', b'\x00\xff', b'\x01')))

    def test_array_lexicographic(self):
        self.ordered(*(prefix() + x for x in (
            array(), array(number(1)), array(number(1), number(0)), array(number(2)))))
        self.equal(prefix() + array(array(number(-0.0))),
                   prefix() + array(array(number(0.0))))

    def test_store_exists_blob(self):
        for index in (1, 2, 3):
            self.equal(prefix(index=index) + number(-0.0), prefix(index=index) + number(0.0))

    def test_global_simple_metadata(self):
        self.ordered(*(prefix(0, 0, 0) + bytes([i]) for i in range(7)))
        self.equal(prefix(0, 0, 0) + b'\x00', prefix(0, 0, 0, (8, 8, 4)) + b'\x00')

    def test_database_simple_metadata(self):
        self.ordered(*(prefix(1, 0, 0) + bytes([i]) for i in range(6)))

    def test_scopes(self):
        self.ordered(*(prefix(0, 0, 0) + b'\x32' + value
                       for value in (b'', b'\x00', b'\x00\xff', b'\xff')))

    def test_global_freelist(self):
        self.ordered(*(prefix(0, 0, 0) + b'\x64' + vi(i) for i in (0, 127, 128, 256)))

    def test_database_names(self):
        self.ordered(*(prefix(0, 0, 0) + b'\xc9' + string(a) + string(b)
                       for a, b in (('', ''), ('a', 'a'), ('a', 'b'), ('b', ''))))

    def test_structured_metadata(self):
        p = prefix(1, 0, 0)
        for tag, fields in ((50, lambda i: vi(i) + b'\x00'),
                            (100, lambda i: vi(1) + vi(i) + b'\x00'),
                            (150, vi), (151, lambda i: vi(1) + vi(i))):
            self.ordered(*(p + bytes([tag]) + fields(i) for i in (0, 127, 128, 256)))
        self.ordered(p + b'\x32\x01\x00', p + b'\x32\x01\x01')
        self.ordered(p + b'\x64\x01\x01\x00', p + b'\x64\x01\x01\x01')

    def test_metadata_names(self):
        for tag, extra in ((200, b''), (201, vi(1))):
            self.ordered(*(prefix(1, 0, 0) + bytes([tag]) + extra + string(x)
                           for x in ('', 'a', 'aa', 'b')))
        self.ordered(prefix(1, 0, 0) + b'\xc9' + vi(1) + string('z'),
                     prefix(1, 0, 0) + b'\xc9' + vi(2) + string('a'))

    def test_index_optional_sequence_equivalence(self):
        p = prefix(index=30) + number(1)
        self.equal(p, p + vi(0), p + vi(999), p + vi(-1))
        self.ordered(p, p + vi(0) + b'\x05')

    def test_index_primary_before_sequence(self):
        p = prefix(index=30) + number(1)
        self.ordered(p + vi(999) + number(1), p + vi(0) + number(2))
        self.ordered(p + vi(-1) + number(1), p + vi(0) + number(1),
                     p + vi(128) + number(1))
        self.equal(p + vi(4) + number(-0.0), p + vi(4) + number(0.0))

    def test_truncated_prefixes_and_payloads(self):
        for whole in (prefix(widths=(8, 8, 4)) + number(1),
                      prefix() + b'\x01' + string('abc'),
                      prefix() + b'\x06\x03abc', prefix() + array(number(1))):
            self.reject(*(whole[:i] for i in range(len(whole))))

    def test_unsupported_and_trailing(self):
        self.reject(prefix() + b'\x07', prefix(index=4) + number(1),
                    prefix(0, 1, 0) + b'\x00', prefix(1, 0, 1) + b'\x00',
                    prefix(0, 0, 0) + b'\x07', prefix(1, 0, 0) + b'\x06',
                    prefix() + number(1) + b'\x00', prefix(0, 0, 0) + b'\x00\x00')

    def test_malformed_varints(self):
        for bad in (b'\x80', b'\x80\x00', b'\xff' * 10 + b'\x01',
                    b'\xff' * 9 + b'\x02', vi(-1)):
            self.reject(prefix() + b'\x06' + bad)
        self.reject(prefix(index=30) + number(1) + b'\x80')

    def test_nan_negative_prefix_and_wrong_input(self):
        self.reject(prefix() + number(math.nan), prefix() + number(math.nan, 2),
                    prefix(1 << 63, 1, 1, (8, 1, 1)) + number(1),
                    None, '', bytearray(prefix() + number(1)))

    def test_array_depth_limit(self):
        self.reject(prefix() + b'\x04\x01' * 130 + number(1))

    def test_metadata_truncations_and_trailing(self):
        for body in (b'\x32\x01\x02', b'\x64\x01\x02\x03',
                     b'\x96\x01', b'\x97\x01\x02',
                     b'\xc8' + string('a'), b'\xc9\x01' + string('a')):
            self.reject(*(prefix(1, 0, 0) + body[:i] for i in range(len(body))))
            self.reject(prefix(1, 0, 0) + body + b'\x00')


if __name__ == '__main__':
    unittest.main()
