import contextlib
import io
import json
import struct
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import probe


def vint(n):
    result = bytearray()
    while n > 127:
        result.append((n & 127) | 128)
        n >>= 7
    result.append(n)
    return bytes(result)


def block(rows):
    data = b''
    for key, value in rows:
        data += vint(0) + vint(len(key)) + vint(len(value)) + key + value
    return data + struct.pack('<II', 0, 1)


def stored(data):
    crc = probe.crc32c(data + b'\0')
    masked = (((crc >> 15) | (crc << 17)) + 0xa282ead8) & 0xffffffff
    return data + b'\0' + struct.pack('<I', masked)


def table(rows):
    data = block(rows)
    index = block([(b'index', vint(0) + vint(len(data)))])
    body = stored(data)
    footer = b'\0\0' + vint(len(body)) + vint(len(index))
    return body + stored(index) + footer.ljust(40, b'\0') + bytes.fromhex('57fb808b247547db')


class ProbeTests(unittest.TestCase):
    def test_compression_overlap_and_literal(self):
        self.assertEqual(probe.snappy(b'\x07\x08xab\x0e\x02\x00'), b'xababab')
        self.assertEqual(probe.snappy(b'\x01\x00x'), b'x')

    def test_invalid_compression_is_fixed_error(self):
        for data in (b'\x04\x01\0', b'\x05\x00x', b'\x01\xf0', b'\x01\x00xx'):
            with self.assertRaisesRegex(probe.Invalid, '^unsupported_or_invalid_structure$'):
                probe.snappy(data)

    def test_table_checksum_and_truncation(self):
        encoded = table([(b'key', b'value')])
        self.assertEqual(list(probe.table_entries(encoded)), [(b'key', b'value')])
        corrupted = bytearray(encoded)
        corrupted[4] ^= 1
        with self.assertRaises(probe.Invalid):
            list(probe.table_entries(corrupted))
        with self.assertRaises(probe.Invalid):
            list(probe.table_entries(encoded[:20]))
        self.assertEqual(probe.crc32c(b'123456789'), 0xe3069283)

    def test_aggregate_does_not_emit_values_or_identifiers(self):
        trailer = b'\x01' + bytes(7)
        rows = [(b'\0\x01\0\0\x32\x02\0' + trailer, 'messages'.encode('utf-16-be')),
                (b'\0\x01\x02\x01PRIVATE-ID' + trailer, b'PRIVATE-CONTENT messageId')]
        result = probe.summarize(rows)
        self.assertEqual(result['historical_object_records_by_store_category'], {'messages': 1})
        self.assertNotIn('PRIVATE', json.dumps(result))

    def test_live_entrypoint_uses_only_allowlisted_origin_and_aggregates(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / 'Library/Containers/com.microsoft.teams2'
            allowed = root / 'IndexedDB/https_teams.microsoft.com_0.indexeddb.leveldb'
            allowed.mkdir(parents=True)
            key = b'\0\x01\x02\x01PRIVATE-ID' + b'\x01' + bytes(7)
            (allowed / '000001.ldb').write_bytes(table([(key, b'PRIVATE-CONTENT')]))
            (allowed / '000002.ldb').write_bytes(b'PRIVATE-CORRUPT-DATA')
            excluded = root / 'IndexedDB/https_other.invalid_0.indexeddb.leveldb'
            excluded.mkdir()
            (excluded / '000003.ldb').write_bytes(b'PRIVATE-CONTENT')
            with patch.object(Path, 'home', return_value=Path(temp)):
                result = probe.probe()
            self.assertEqual(len(result['databases']), 1)
            self.assertEqual(result['databases'][0]['tables_read'], 1)
            self.assertEqual(result['databases'][0]['tables_failed'], 1)
            self.assertNotIn('PRIVATE', json.dumps(result))


if __name__ == '__main__':
    unittest.main()
