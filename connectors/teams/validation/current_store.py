"""Bounded read-only LevelDB reconstruction; bytes never leave the returned view.

Rejects unsupported comparators and unstable/incomplete input. Stability means
unchanged inode/size/mtime/ctime across a complete read interval, not a writer lock.
Bytewise and the supported Chromium IndexedDB coding scheme are supported.
"""
from collections import deque
import os
import re
import stat
from pathlib import Path

LIMIT = 64 * 1024 * 1024
TOTAL_LIMIT = 256 * 1024 * 1024
ENTRY_LIMIT = 1000000
FILE_LIMIT = 4096
SEQ_LIMIT = (1 << 56) - 1
ORIGINS = frozenset(("https_teams.microsoft.com_0.indexeddb.leveldb",
                     "https_teams.cloud.microsoft_0.indexeddb.leveldb"))
class Invalid(Exception):
    pass


class ReadFailure(Invalid):
    def __init__(self, stage):
        super().__init__('unavailable')
        self.stage = stage

def require(ok):
    if not ok:
        raise Invalid("unsupported_or_invalid_structure")

def varint(data, pos=0):
    value = 0
    for shift in range(0, 70, 7):
        require(pos < len(data))
        b = data[pos]
        pos += 1
        value |= (b & 127) << shift
        if b < 128:
            require(value < 1 << 64)
            return value, pos
    raise Invalid("unsupported_or_invalid_structure")

def snappy(data):
    size, p = varint(data)
    require(size <= LIMIT)
    out = bytearray()
    while p < len(data):
        tag = data[p]
        p += 1
        kind = tag & 3
        if kind == 0:
            n = tag >> 2
            if n < 60:
                n += 1
            else:
                width = n - 59
                require(p + width <= len(data))
                n = int.from_bytes(data[p:p + width], "little") + 1
                p += width
            require(p + n <= len(data) and len(out) + n <= size)
            out.extend(data[p:p + n])
            p += n
        else:
            width = {1: 1, 2: 2, 3: 4}[kind]
            require(p + width <= len(data))
            offset = int.from_bytes(data[p:p + width], "little")
            p += width
            if kind == 1:
                offset |= (tag & 224) << 3
                n = 4 + ((tag >> 2) & 7)
            else:
                n = 1 + (tag >> 2)
            require(0 < offset <= len(out) and len(out) + n <= size)
            for _ in range(n):
                out.append(out[-offset])
    require(len(out) == size)
    return bytes(out)

def entries(block):
    require(len(block) >= 8)
    count = int.from_bytes(block[-4:], 'little')
    require(0 < count <= (len(block) - 4) // 4)
    end = len(block) - 4 * (count + 1)
    restarts = [int.from_bytes(block[i:i + 4], 'little')
                for i in range(end, len(block) - 4, 4)]
    require(restarts[0] == 0 and all(a < b for a, b in zip(restarts, restarts[1:])))
    require((end == 0 and restarts == [0]) or restarts[-1] < end)
    p, key, found = 0, b'', set()
    restart_set = set(restarts)
    while p < end:
        start = p
        shared, p = varint(block, p)
        added, p = varint(block, p)
        length, p = varint(block, p)
        require(shared <= len(key) and p + added + length <= end)
        if start in restart_set:
            require(shared == 0)
            found.add(start)
        key = key[:shared] + block[p:p + added]
        p += added
        value = block[p:p + length]
        p += length
        yield key, value
    require(p == end and (end == 0 or found == restart_set))

def handle(data, p=0):
    offset, p = varint(data, p)
    size, p = varint(data, p)
    return (offset, size), p

def crc32c_entry(byte):
    for _ in range(8):
        byte = (byte >> 1) ^ (0x82f63b78 if byte & 1 else 0)
    return byte

CRC32C_TABLE = tuple(crc32c_entry(byte) for byte in range(256))

def crc32c(data):
    crc = 0xffffffff
    for byte in data:
        crc = (crc >> 8) ^ CRC32C_TABLE[(crc ^ byte) & 255]
    return crc ^ 0xffffffff

def block_at(data, location, budget=None):
    offset, size = location
    require(size <= LIMIT and offset + size + 5 <= len(data) - 48)
    block = data[offset:offset + size]
    compression = data[offset + size]
    require(compression in (0, 1))
    checksum = crc32c(data[offset:offset + size + 1])
    masked = (((checksum >> 15) | (checksum << 17)) + 0xa282ead8) & 0xffffffff
    require(masked == int.from_bytes(data[offset + size + 1:offset + size + 5], "little"))
    expanded = varint(block)[0] if compression else len(block)
    require(expanded <= LIMIT)
    if budget is not None:
        budget[0] += expanded
        require(budget[0] <= TOTAL_LIMIT)
    return snappy(block) if compression == 1 else block

def table_entries(data, budget=None, user_order=None):
    key_order = lambda key: order(key, user_order)
    budget = [0] if budget is None else budget
    require(48 <= len(data) <= LIMIT and data[-8:] == bytes.fromhex('57fb808b247547db'))
    meta, p = handle(data[-48:-8])
    index, p = handle(data[-48:-8], p)
    require(not any(data[-48:-8][p:]))

    for _, value in entries(block_at(data, meta, budget)):
        location, used = handle(value)
        require(used == len(value))
        block_at(data, location, budget)
    prior_end = 0
    prior_index = None
    for index_key, value in entries(block_at(data, index, budget)):
        require(prior_index is None or key_order(prior_index) < key_order(index_key))
        prior_index = index_key
        location, used = handle(value)
        require(used == len(value) and location[0] >= prior_end)
        prior_end = location[0] + location[1] + 5
        require(prior_end <= meta[0] and meta[0] + meta[1] + 5 <= index[0])
        for key, value in entries(block_at(data, location, budget)):
            require(key_order(key) <= key_order(index_key))
            yield key, value


def masked_crc(data):
    n = crc32c(data)
    return (((n >> 15) | (n << 17)) + 0xa282ead8) & 0xffffffff


def records(data):
    """Strict LevelDB physical log framing: no partial-tail recovery."""
    pending = None
    p = 0
    while p < len(data):
        room = 32768 - p % 32768
        if room < 7:
            require(p + room <= len(data) and not any(data[p:p + room]))
            p += room
            continue
        require(len(data) - p >= 7)
        checksum = int.from_bytes(data[p:p + 4], 'little')
        size = int.from_bytes(data[p + 4:p + 6], 'little')
        kind = data[p + 6]
        require(kind in (1, 2, 3, 4) and size <= room - 7 and p + 7 + size <= len(data))
        piece = data[p + 7:p + 7 + size]
        require(masked_crc(bytes([kind]) + piece) == checksum)
        p += 7 + size
        if kind == 1:
            require(pending is None)
            yield piece
        elif kind == 2:
            require(pending is None)
            pending = bytearray(piece)
        else:
            require(pending is not None and len(pending) + size <= LIMIT)
            pending.extend(piece)
            if kind == 4:
                yield bytes(pending)
                pending = None
    require(pending is None)


class Cursor:
    def __init__(self, data):
        self.data, self.p = data, 0

    def number(self):
        value, self.p = varint(self.data, self.p)
        return value

    def blob(self):
        size = self.number()
        require(size <= LIMIT and self.p + size <= len(self.data))
        value = self.data[self.p:self.p + size]
        self.p += size
        return value


def internal(key):
    require(len(key) >= 8)
    tag = int.from_bytes(key[-8:], 'little')
    require(tag & 255 in (0, 1))
    return key[:-8], tag >> 8, tag & 255


def manifest(data):
    files, fields = {}, {}
    edits = 0
    for record in records(data):
        edits += 1
        require(edits <= ENTRY_LIMIT)
        c = Cursor(record)
        additions, deletions, update = [], [], {}
        while c.p < len(record):
            tag = c.number()
            if tag == 1:
                require(tag not in update)
                update[tag] = c.blob()
                comparator(update[tag])
                require(1 not in fields or fields[1] == update[tag])
            elif tag in (2, 3, 4, 9):
                require(tag not in update)
                update[tag] = c.number()
                if tag == 4:
                    require(update[tag] <= SEQ_LIMIT)
            elif tag in (5, 6, 7):
                level = c.number()
                require(level < 7)
                if tag == 5:
                    internal(c.blob())
                    continue
                number = c.number()
                require(number > 0)
                if tag == 6:
                    deletions.append((level, number))
                else:
                    size, low, high = c.number(), c.blob(), c.blob()
                    internal(low)
                    internal(high)
                    require(48 <= size <= LIMIT)
                    additions.append((number, (level, size, low, high)))
            else:
                require(False)
        for tag in (2, 3, 4):
            if tag in update and tag in fields:
                require(update[tag] >= fields[tag])
        for level, number in deletions:
            require(number in files and files[number][0] == level)
            del files[number]
        for number, value in additions:
            require(number not in files)
            files[number] = value
        fields.update(update)
        require(len(files) <= FILE_LIMIT)
    require(all(tag in fields for tag in (1, 2, 3, 4)))
    require(all(n < fields[3] for n in files))
    require(fields[2] < fields[3] and fields.get(9, 0) < fields[3])
    user_order = comparator(fields[1])
    for _, _, low, high in files.values():
        require(order(low, user_order) <= order(high, user_order))
    return files, fields, edits


def comparator(name):
    if name == b'leveldb.BytewiseComparator':
        return lambda key: key
    if name == b'idb_cmp1':
        from idb_comparator import canonical_key
        return canonical_key
    raise Invalid('unsupported_comparator')


def order(key, user_order=None):
    user, seq, kind = internal(key)
    return user if user_order is None else user_order(user), -seq, -kind


def batch(data):
    require(len(data) >= 12)
    seq = int.from_bytes(data[:8], 'little')
    count = int.from_bytes(data[8:12], 'little')
    require(count <= ENTRY_LIMIT and seq <= SEQ_LIMIT and seq + max(count - 1, 0) <= SEQ_LIMIT)
    c = Cursor(data)
    c.p = 12
    for i in range(count):
        require(c.p < len(data))
        kind = data[c.p]
        c.p += 1
        require(kind in (0, 1))
        key = c.blob()
        value = c.blob() if kind else b''
        yield key, seq + i, kind, value
    require(c.p == len(data))


def signature(s):
    return (s.st_dev, s.st_ino, s.st_mode, s.st_size, s.st_mtime_ns, s.st_ctime_ns)


def open_directory(path):
    """Walk each component using directory descriptors; never follow links."""
    path = Path(os.path.abspath(path))
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in path.parts[1:]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = child
        return fd
    except BaseException:
        os.close(fd)
        raise


class Snapshot:
    def __init__(self, path):
        self.fd = open_directory(path)
        self.start = signature(os.fstat(self.fd))
        self.seen = {}
        self.total = 0

    def names(self):
        result = []
        with os.scandir(self.fd) as it:
            for entry in it:
                result.append(entry.name)
                require(len(result) <= FILE_LIMIT)
        return set(result)

    def read(self, name):
        require('/' not in name and name not in ('.', '..'))
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=self.fd)
        try:
            before = os.fstat(fd)
            require(stat.S_ISREG(before.st_mode) and before.st_size <= LIMIT)
            self.total += before.st_size
            require(self.total <= TOTAL_LIMIT)
            chunks = bytearray()
            while len(chunks) <= before.st_size:
                part = os.read(fd, min(1024 * 1024, before.st_size + 1 - len(chunks)))
                if not part:
                    break
                chunks.extend(part)
            require(len(chunks) == before.st_size)
            require(signature(before) == signature(os.fstat(fd)))
            self.seen[name] = signature(before)
            return bytes(chunks)
        finally:
            os.close(fd)

    def verify(self, names):
        require(self.names() == names and signature(os.fstat(self.fd)) == self.start)
        for name, sig in self.seen.items():
            require(signature(os.stat(name, dir_fd=self.fd, follow_symlinks=False)) == sig)


def _current_view(path, expected_directory=None):
    stage = 'stability'
    snap = Snapshot(path)
    try:
        require(expected_directory is None or snap.start[:2] == expected_directory)
        names = snap.names()
        stage = 'manifest'
        current = snap.read('CURRENT')
        require(re.fullmatch(rb'MANIFEST-[0-9]+\n', current) is not None)
        require(len(current) <= 64)
        files, fields, edits = manifest(snap.read(current[:-1].decode('ascii')))
        stage = 'tables'
        tables = deque()
        for number, (_, size, low, high) in files.items():
            candidates = [n for n in names if re.fullmatch(r'[0-9]+\.(ldb|sst)', n) and int(n.split('.')[0]) == number]
            require(len(candidates) == 1)
            data = snap.read(candidates[0])
            require(len(data) == size)
            tables.append((data, low, high))
        stage = 'wal'
        logs = {}
        for name in names:
            if re.fullmatch(r'[0-9]+\.log', name):
                number = int(name.split('.')[0])
                if number >= fields[2] or number == fields.get(9, 0):
                    require(number not in logs)
                    logs[number] = name
        require(not fields[2] or fields[2] in logs)
        require(not fields.get(9, 0) or fields[9] in logs)
        log_data = deque(snap.read(logs[number]) for number in sorted(logs))
        stage = 'stability'
        snap.verify(names)

        fd = open_directory(path)
        try:
            require(signature(os.fstat(fd)) == snap.start)
        finally:
            os.close(fd)

        user_order = comparator(fields[1])
        latest, versions = {}, {}
        count = 0
        decoded = 0
        expansion_budget = [0]

        def accept(user, seq, kind, value):
            nonlocal count, decoded
            count += 1
            decoded += len(user) + len(value) + 16
            require(count <= ENTRY_LIMIT and decoded <= TOTAL_LIMIT)
            require(kind or not value)
            logical = user_order(user)
            ident = logical, seq
            item = kind, value
            require(ident not in versions or versions[ident] == item)
            versions[ident] = item
            if logical not in latest or latest[logical][0] < seq:
                latest[logical] = seq, kind, value, user

        stage = 'tables'
        while tables:
            data, low, high = tables.popleft()
            first = last = None
            for key, value in table_entries(data, expansion_budget, user_order):
                require(last is None or order(last, user_order) < order(key, user_order))
                first = key if first is None else first
                last = key
                user, seq, kind = internal(key)
                require(seq <= fields[4])
                accept(user, seq, kind, value)
            require(first is not None and order(first, user_order) == order(low, user_order)
                    and order(last, user_order) == order(high, user_order))
        stage = 'wal'
        batches = 0
        while log_data:
            data = log_data.popleft()
            previous = -1
            for record in records(data):
                batches += 1
                require(batches <= ENTRY_LIMIT)
                for user, seq, kind, value in batch(record):
                    require(seq > previous)
                    previous = seq
                    accept(user, seq, kind, value)
        result = {user: v for _, kind, v, user in latest.values() if kind}
        return result, {'stable': True, 'checksums_verified': True,
                        'tables': len(files), 'logs': len(logs), 'manifest_edits': edits,
                        'batches': batches, 'records': count, 'current_keys': len(result),
                        'tombstones': len(latest) - len(result), 'bytes_read': snap.total}
    except Exception:
        pass
    finally:
        os.close(snap.fd)
    raise ReadFailure(stage) from None


def current_view(path, expected_directory=None):
    """Return (current byte-key/value mapping, fixed-key counts/booleans).

    Raises Invalid with a static message and no chained exception on all
    unsupported, inaccessible, corrupt, over-budget or observed unstable input.
    Callers must never print the returned mapping or raw exception diagnostics.
    """
    try:
        return _current_view(path, expected_directory)
    except ReadFailure:
        raise
    except Exception:
        pass
    raise Invalid('unavailable') from None


def discover():
    """Return only fixed Teams-origin directories, without following symlinks.

    Directory metadata only; paths returned in memory must not be logged.
    A missing container gives []; traversal failures fail closed.
    """
    root = Path.home() / 'Library/Containers/com.microsoft.teams2'
    result = []
    def walk(fd, path, depth, budget):
        require(depth <= 32)
        with os.scandir(fd) as it:
            for entry in it:
                budget[0] += 1
                require(budget[0] <= 100000)
                if entry.is_dir(follow_symlinks=False):
                    child = os.open(entry.name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                    try:
                        target = path / entry.name
                        if entry.name in ORIGINS:
                            result.append(target)
                            require(len(result) <= 64)
                        else:
                            walk(child, target, depth + 1, budget)
                    finally:
                        os.close(child)
    try:
        try:
            fd = open_directory(root)
        except FileNotFoundError:
            return []
        try:
            walk(fd, root, 0, [0])
        finally:
            os.close(fd)
        return result
    except Exception:
        pass
    raise Invalid('unavailable') from None
