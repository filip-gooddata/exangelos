"""Strict canonical form for Chromium's LevelDB CompareKeys (not CompareIndexKeys).

Public sources fetched 2026-11-13:
https://github.com/chromium/chromium/blob/main/content/browser/indexed_db/indexed_db_leveldb_coding.cc
https://github.com/chromium/chromium/blob/main/content/browser/indexed_db/indexed_db_leveldb_coding.h
https://github.com/chromium/chromium/blob/main/content/browser/indexed_db/docs/leveldb_coding_scheme.md
https://github.com/chromium/chromium/blob/main/third_party/blink/public/mojom/indexeddb/indexeddb.mojom
https://github.com/chromium/chromium/blob/main/components/services/storage/indexed_db/scopes/varint_coding.cc

Supports little-endian Chromium doubles, logical prefixes, metadata, scopes,
store/exists/blob keys, and index keys with optional sequence/primary suffixes.
Min/null sentinels and infinite doubles are supported. NaNs, unknown families,
inconsistent metadata prefixes, trailing bytes, noncanonical varints, and
arrays nested beyond 128 are rejected. This is a strict subset of Chromium's
permissive comparator: ignored trailing bytes are deliberately not accepted.
Returned tuples contain decoded key material; callers must never log them.
"""

import math
import struct

_ERROR = "Unsupported or malformed IndexedDB key"
_MAX_INT64 = (1 << 63) - 1
_RANK = {5: 0, 3: 1, 2: 2, 1: 3, 6: 4, 4: 5, 0: 6}


def _reject():
    raise ValueError(_ERROR)


class _Reader:
    def __init__(self, data):
        self.data = data
        self.pos = 0

    def remaining(self):
        return len(self.data) - self.pos

    def take(self, count):
        if count < 0 or count > self.remaining():
            _reject()
        start = self.pos
        self.pos += count
        return self.data[start:self.pos]

    def byte(self):
        return self.take(1)[0]

    def varint(self, signed=False):
        result = 0
        for shift in range(0, 70, 7):
            byte = self.byte()
            if (shift and byte == 0) or (shift == 63 and byte > 1):
                _reject()
            result |= (byte & 127) << shift
            if not byte & 128:
                if result > _MAX_INT64:
                    if not signed:
                        _reject()
                    result -= 1 << 64
                return result
        _reject()

    def string(self):


        return self.take(self.varint() * 2)

    def key(self, depth=0):
        if depth > 128:
            _reject()
        kind = self.byte()
        if kind not in _RANK:
            _reject()
        rank = _RANK[kind]
        if kind in (0, 5):
            return (rank,)
        if kind in (2, 3):
            number = struct.unpack('<d', self.take(8))[0]
            if math.isnan(number):
                _reject()
            return (rank, number)
        if kind == 1:
            return (rank, self.string())
        if kind == 6:
            return (rank, self.take(self.varint()))
        count = self.varint()
        if count > self.remaining():
            _reject()
        return (rank, tuple(self.key(depth + 1) for _ in range(count)))


def _metadata(reader, global_metadata):
    kind = reader.byte()
    if kind < (7 if global_metadata else 6):
        fields = ()
    elif global_metadata:
        if kind == 50:
            fields = (reader.take(reader.remaining()),)
        elif kind == 100:
            fields = (reader.varint(),)
        elif kind == 201:
            fields = (reader.string(), reader.string())
        else:
            _reject()
    elif kind == 50:
        fields = (reader.varint(), reader.byte())
    elif kind == 100:
        fields = (reader.varint(), reader.varint(), reader.byte())
    elif kind == 150:
        fields = (reader.varint(),)
    elif kind == 151:
        fields = (reader.varint(), reader.varint())
    elif kind == 200:
        fields = (reader.string(),)
    elif kind == 201:
        fields = (reader.varint(), reader.string())
    else:
        _reject()
    return (kind,) + fields


def canonical_key(data: bytes) -> tuple:
    """Return a hashable, orderable CompareKeys form; fail with a static error.

    Input is the LevelDB user key, without its internal version/type trailer.
    This function neither reads storage nor returns a printable diagnostic.
    """
    if type(data) is not bytes:
        _reject()
    reader = _Reader(data)
    widths = reader.byte()
    database, store, index = (
        int.from_bytes(reader.take(width), 'little')
        for width in ((widths >> 5) + 1, ((widths >> 2) & 7) + 1,
                      (widths & 3) + 1)
    )
    if database > _MAX_INT64 or store > _MAX_INT64:
        _reject()
    prefix = (database, store, index)
    if database == 0 or store == 0:
        if index != 0 or (database == 0 and store != 0):
            _reject()
        if database == _MAX_INT64:
            _reject()
        suffix = _metadata(reader, database == 0)
    elif index in (1, 2, 3):
        suffix = (reader.key(),)
    elif index >= 30:
        key = reader.key()
        sequence = reader.varint(signed=True) if reader.remaining() else -1

        if reader.remaining():
            suffix = (key, 1, reader.key(), sequence)
        else:
            suffix = (key, 0)
    else:
        _reject()
    if reader.remaining():
        _reject()
    return prefix + (suffix,)
