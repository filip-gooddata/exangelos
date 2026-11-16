"""Bounded projection of a deliberately small V8 wire-format subset.

Wire reference: CCL Chromium reader at 1bc482c0078cad4288ad0a0072ef46d7d7929596,
serialization_formats/ccl_v8_value_deserializer.py (Constants and JS object/dense
array readers). See vendor/LEVELDB-LICENSE and ../THIRD_PARTY_NOTICES.md.
V16 changes buffer lengths/offsets; plain ArrayBuffers are skipped within caps.
Direct fixed-buffer views are skipped; resizable/shared/transferred buffers rejected.
Reference: https://github.com/v8/v8/blob/main/src/objects/value-serializer.cc
This module neither imports that deserializer nor opens any data source.
"""

from dataclasses import dataclass


class FieldV8Error(ValueError):
    """Rejected input; messages are fixed codes and never include input data."""


@dataclass(frozen=True)
class Limits:
    max_bytes: int = 4 * 1024 * 1024
    max_nodes: int = 100_000
    max_depth: int = 48
    max_string_bytes: int = 256 * 1024
    max_array_length: int = 10_000


_FIELDS = ("type", "ts", "channel", "team", "thread_ts", "text")
_KEYS = {
    tag: tuple((name.encode(encoding), name) for name in _FIELDS)
    for tag, encoding in ((ord('"'), 'latin1'), (ord('S'), 'utf8'), (ord('c'), 'utf-16-le'))
}
_ENCODINGS = {ord('"'): 'latin1', ord('S'): 'utf8', ord('c'): 'utf-16-le'}
_DEFAULTS = Limits()


def read_fields(data: bytes, *, limits: Limits = _DEFAULTS):
    """Project one complete V8 v13-v16 payload to sanitized dict/list/None.

    Pass immutable bytes beginning with FF + version (no Blink/IndexedDB
    envelope). No I/O, vendor import, or generic value deserialization occurs.
    Only string values of type, ts, channel, team, thread_ts survive. A text
    property yields text_present=True and, for a direct string, text_bytes
    (wire payload byte count, NOT Unicode character count); body is not decoded.
    Unknown keys and their ENTIRE subtrees are discarded, including containers
    with otherwise allowlisted keys. Keys are compared as memoryviews against
    static byte allowlists; no unknown key is decoded or returned. An allowlisted
    identity field with a non-string value is also discarded in its entirety.

    Root objects and dense arrays are traversal structure; primitive array/root
    values become None. Dense-array named properties are validated then dropped.
    Reference IDs count every encountered object/array, including skipped ones.
    ALL valid references become None (never followed, including cycles).

    Supported values: plain objects, dense arrays, three string encodings,
    null/undefined/hole/bool, int32/uint32/double, plain ArrayBuffers (skipped without decoding), and object references. Other
    tags, versions, malformed framing, trailing bytes, and exceeded limits raise
    FieldV8Error with a fixed code. There is no partial return on failure. Limits
    may only tighten the defaults. Input bytes remain the caller's responsibility;
    do not log raw bytes, exceptions' tracebacks/locals, or identity values.
    """
    if type(data) is not bytes or type(limits) is not Limits:
        raise FieldV8Error('input')
    for name in Limits.__dataclass_fields__:
        value = getattr(limits, name)
        if type(value) is not int or not 1 <= value <= getattr(_DEFAULTS, name):
            raise FieldV8Error('limits')
    if len(data) > limits.max_bytes:
        raise FieldV8Error('bytes_limit')
    reader = _Reader(data, limits)
    if reader.byte() != 255:
        raise FieldV8Error('header')
    reader.version = reader.uint()
    if reader.version not in (13, 14, 15, 16):
        raise FieldV8Error('header')
    result = reader.value(0, 'structure')

    while reader.pos < len(reader.data) and reader.data[reader.pos] == 0:
        reader.pos += 1
    if reader.pos != len(reader.data):
        raise FieldV8Error('trailing')
    return result


class _Reader:
    def __init__(self, data, limits):
        self.data = memoryview(data)
        self.limits = limits
        self.pos = 0
        self.nodes = 0
        self.objects = 0

    def take(self, size):
        end = self.pos + size
        if end > len(self.data):
            raise FieldV8Error('truncated')
        result = self.data[self.pos:end]
        self.pos = end
        return result

    def byte(self):
        if self.pos >= len(self.data):
            raise FieldV8Error('truncated')
        result = self.data[self.pos]
        self.pos += 1
        return result

    def uint(self):
        result = 0
        for shift in range(0, 35, 7):
            byte = self.byte()
            if shift == 28 and byte > 15:
                raise FieldV8Error('varint')
            result |= (byte & 127) << shift
            if byte < 128:
                if shift and byte == 0:
                    raise FieldV8Error('varint')
                return result
        raise FieldV8Error('varint')

    def tag(self):
        tag = self.byte()
        while tag == 0:
            tag = self.byte()
        return tag

    def node(self, depth):
        self.nodes += 1
        if self.nodes > self.limits.max_nodes:
            raise FieldV8Error('nodes_limit')
        if depth > self.limits.max_depth:
            raise FieldV8Error('depth_limit')

    def string_span(self, tag):
        size = self.uint()
        if size > self.limits.max_string_bytes:
            raise FieldV8Error('string_limit')
        if tag == ord('c') and size % 2:
            raise FieldV8Error('string_encoding')
        return self.take(size)

    def key(self, depth, tag):
        self.node(depth)
        if tag in _KEYS:
            span = self.string_span(tag)
            for raw, name in _KEYS[tag]:
                if span == raw:
                    return name
            return None
        if tag in (ord('I'), ord('U')):
            self.uint()
            return None
        raise FieldV8Error('key_tag')

    def properties(self, depth, end_tag, output):
        count = 0
        seen = set()
        while True:
            tag = self.tag()
            if tag == end_tag:
                break
            key = self.key(depth + 1, tag)
            count += 1
            if output is not None and key is not None:
                if key in seen:
                    raise FieldV8Error('duplicate_field')
                seen.add(key)
                value = self.value(depth + 1, 'text' if key == 'text' else 'identity')
                if key == 'text':
                    output['text_present'] = True
                    if value is not None:
                        output['text_bytes'] = value
                elif value is not None:
                    output[key] = value
            else:
                self.value(depth + 1, 'skip')
        if self.uint() != count:
            raise FieldV8Error('property_count')

    def value(self, depth, mode):
        self.node(depth)
        tag = self.tag()
        if tag in _ENCODINGS:
            span = self.string_span(tag)
            if mode == 'text':
                return len(span)
            if mode == 'identity':
                try:
                    return str(span, _ENCODINGS[tag])
                except UnicodeError:
                    raise FieldV8Error('string_encoding') from None
            return None
        if tag in b'0_TF-':
            return None
        if tag in b'IU':
            self.uint()
            return None
        if tag == ord('N'):
            self.take(8)
            return None
        if tag == ord('^'):
            if self.uint() >= self.objects:
                raise FieldV8Error('reference')
            return None
        if tag == ord('o'):
            self.objects += 1
            output = {} if mode == 'structure' else None
            self.properties(depth, ord('{'), output)
            return output
        if tag == ord('A'):
            self.objects += 1
            length = self.uint()
            if length > self.limits.max_array_length:
                raise FieldV8Error('array_limit')
            output = [] if mode == 'structure' else None
            for _ in range(length):
                item = self.value(depth + 1, 'structure' if output is not None else 'skip')
                if output is not None:
                    output.append(item)
            self.properties(depth, ord('$'), None)
            if self.uint() != length:
                raise FieldV8Error('array_length')
            return output
        if tag == ord('B'):
            self.objects += 1
            size = self.uint()
            if size > self.limits.max_bytes:
                raise FieldV8Error('bytes_limit')
            self.take(size)
            if self.pos < len(self.data) and self.data[self.pos] == ord('V'):
                self.pos += 1
                subtype, offset, length = self.uint(), self.uint(), self.uint()
                flags = self.uint() if self.version >= 14 else 0
                widths = {ord(k): v for k, v in (('b',1),('B',1),('C',1),('w',2),('W',2),('d',4),('D',4),('f',4),('F',8),('q',8),('Q',8),('?',1))}
                width = widths.get(subtype)
                if width is None or flags or offset + length > size or offset % width or length % width:
                    raise FieldV8Error('buffer_view')
                self.objects += 1
            return None
        for wire, code in ((ord('a'), 'sparse_array'),
                           (ord(';'), 'map'), (ord("'"), 'set'), (ord('\\'), 'host_object'),
                           (ord('D'), 'date'), (ord('Z'), 'bigint')):
            if tag == wire:
                raise FieldV8Error(code)
        raise FieldV8Error('unsupported_tag')
