"""Aggregate-only candidate projection. No source captures or credential decoding."""
import collections
import contextlib
import io
import json
import logging
from pathlib import Path
import re
import struct
import sys

from field_v8 import read_fields, FieldV8Error

HERE = Path(__file__).resolve().parent
CAP = 16 * 1024 * 1024
READER_FAILURES = ('header', 'key_tag', 'unsupported_tag', 'trailing', 'property_count', 'string_limit', 'reference', 'array_length', 'truncated', 'varint', 'array_buffer', 'sparse_array', 'map', 'set', 'host_object', 'date', 'bigint')


def uint(s):
    n = 0
    for shift in range(0, 70, 7):
        b = s.read(1)
        if not b:
            raise ValueError('framing')
        n |= (b[0] & 127) << shift
        if b[0] < 128:
            return n
    raise ValueError('framing')


def take(s, n):
    if n < 0 or n > CAP:
        raise ValueError('bounds')
    b = s.read(n)
    if len(b) != n:
        raise ValueError('framing')
    return b


def snappy(s):
    size = uint(s)
    if size > CAP:
        raise ValueError('bounds')
    out = bytearray()
    while b := s.read(1):
        t = b[0]
        kind = t & 3
        if kind == 0:
            v = t >> 2
            n = v + 1 if v < 60 else int.from_bytes(take(s, v - 59), 'little') + 1
            if len(out) + n > size:
                raise ValueError('bounds')
            out.extend(take(s, n))
        else:
            if kind == 1:
                n, offset = ((t >> 2) & 7) + 4, ((t & 224) << 3) | take(s, 1)[0]
            else:
                n, offset = (t >> 2) + 1, int.from_bytes(take(s, 2 if kind == 2 else 4), 'little')
            if not 0 < offset <= len(out) or len(out) + n > size:
                raise ValueError('bounds')
            for _ in range(n):
                out.append(out[-offset])
    if len(out) != size:
        raise ValueError('framing')
    return bytes(out)


def payload(raw):
    s = io.BytesIO(raw)
    uint(s)
    envelope = s.read()
    for _ in range(3):
        s = io.BytesIO(envelope)
        if take(s, 1) != b'\xff':
            raise ValueError('envelope')
        version = uint(s)
        if version == 17:
            tag = take(s, 1)
            if tag == b'\x01':
                return None
            if tag != b'\x02':
                raise ValueError('envelope')
            envelope = snappy(s)
            continue
        if not 18 <= version <= 21:
            raise ValueError('envelope')
        if version == 21:
            tag, offset, length = struct.unpack('>cQI', take(s, 13))
            if tag != b'\xfe' or offset or length:
                raise ValueError('trailer')
        return s.read()
    raise ValueError('envelope')


def prefix(key):
    if not key:
        raise ValueError('prefix')
    tag = key[0]
    widths = ((tag >> 5) + 1, ((tag >> 2) & 7) + 1, (tag & 3) + 1)
    s = io.BytesIO(key[1:])
    return tuple(int.from_bytes(take(s, n), 'little') for n in widths)


def reconcile(records, counts):
    latest = {}
    conflicts = set()
    for record in records:
        counts['physical_records'] += 1
        previous = latest.get(record.user_key)
        if previous is None or record.seq > previous.seq:
            latest[record.user_key] = record
            conflicts.discard(record.user_key)
        elif record.seq == previous.seq and (record.value != previous.value or record.state != previous.state):
            conflicts.add(record.user_key)
    counts['conflicting_latest_keys'] += len(conflicts)
    counts['latest_observed_keys'] += len(latest)
    return [r for k, r in latest.items() if k not in conflicts]


def main(run=None):
    logging.disable(logging.CRITICAL)
    code = 0
    with open('/dev/null', 'w') as sink, contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink):
        try:
            result = run(Path.home() / 'Library/Application Support/Slack/IndexedDB')
        except BaseException:
            result, code = {'probe_failed': True}, 1
    print(json.dumps(result, sort_keys=True))
    return code
