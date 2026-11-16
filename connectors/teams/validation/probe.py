"""Throwaway read-only Teams SSTable structure probe. No record values leave memory.
Not a logical LevelDB snapshot: excludes WAL, manifest and deletion reconciliation.
"""
import collections
import json
import os
from pathlib import Path

LIMIT = 64 * 1024 * 1024
CATEGORIES = ("messages", "message", "conversations", "conversation", "chats", "threads")

class Invalid(Exception):
    pass

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
    count = int.from_bytes(block[-4:], "little")
    require(0 < count <= (len(block) - 4) // 4)
    end = len(block) - 4 * (count + 1)
    p = 0
    key = b""
    while p < end:
        shared, p = varint(block, p)
        added, p = varint(block, p)
        length, p = varint(block, p)
        require(shared <= len(key) and p + added + length <= end)
        key = key[:shared] + block[p:p + added]
        p += added
        value = block[p:p + length]
        p += length
        yield key, value
    require(p == end)

def handle(data, p=0):
    offset, p = varint(data, p)
    size, p = varint(data, p)
    return (offset, size), p

def crc32c(data):
    crc = 0xffffffff
    for byte in data:
        crc ^= byte
        for _ in range(8):
            crc = (crc >> 1) ^ (0x82f63b78 if crc & 1 else 0)
    return crc ^ 0xffffffff

def block_at(data, location):
    offset, size = location
    require(size <= LIMIT and offset + size + 5 <= len(data) - 48)
    block = data[offset:offset + size]
    compression = data[offset + size]
    require(compression in (0, 1))
    checksum = crc32c(data[offset:offset + size + 1])
    masked = (((checksum >> 15) | (checksum << 17)) + 0xa282ead8) & 0xffffffff
    require(masked == int.from_bytes(data[offset + size + 1:offset + size + 5], "little"))
    return snappy(block) if compression == 1 else block

def table_entries(data):
    require(48 <= len(data) <= LIMIT and data[-8:] == bytes.fromhex("57fb808b247547db"))
    _, p = handle(data[-48:-8])
    index, _ = handle(data[-48:-8], p)
    for _, value in entries(block_at(data, index)):
        location, _ = handle(value)
        yield from entries(block_at(data, location))

def prefix(key):
    require(len(key) >= 4)
    lengths = ((key[0] >> 5) + 1, ((key[0] >> 2) & 7) + 1, (key[0] & 3) + 1)
    p = 1
    ids = []
    for n in lengths:
        require(p + n <= len(key))
        ids.append(int.from_bytes(key[p:p + n], "little"))
        p += n
    return (*ids, p)

def summarize(records):
    stores = {}
    counts = collections.Counter()
    data_counts = collections.Counter()
    marker_counts = collections.Counter()
    for internal_key, value in records:
        require(len(internal_key) >= 8)
        key, trailer = internal_key[:-8], internal_key[-8:]
        record_type = trailer[0]
        if record_type == 0:
            counts["table_tombstones"] += 1
            continue
        require(record_type == 1)
        db, store, index, p = prefix(key)
        counts["table_entries"] += 1
        if db and not store and not index and key[p:p + 1] == b"2":
            sid, q = varint(key, p + 1)
            if key[q:] == b"\x00":
                category = "other"
                for allowed in CATEGORIES:
                    if value == allowed.encode("utf-16-be"):
                        category = allowed
                if category == "other":
                    try:
                        name = value.decode("utf-16-be").lower()
                        if "message" in name:
                            category = "message_related"
                    except UnicodeError:
                        pass
                stores[(db, sid)] = category
        if db and store and index == 1:
            data_counts[(db, store)] += 1

            for marker in ("messageId", "conversationId", "content", "createdTime"):
                if marker.encode() in value or marker.encode("utf-16-le") in value:
                    marker_counts[marker] += 1
    categories = collections.Counter(stores.values())
    rows = collections.Counter()
    for sid, n in data_counts.items():
        rows[stores.get(sid, "unmapped")] += n
    return {"counts": dict(counts), "store_categories": dict(categories),
            "historical_object_records_by_store_category": dict(rows),
            "heuristic_marker_record_counts": dict(marker_counts)}

def historical_serialization(records):
    """First-failure coverage of historical SST values, never a current view."""
    import serialization as decoder
    out = dict.fromkeys(('historical_rows', 'historical_decoded', 'historical_invalid',
                         'historical_unsupported', 'historical_external_values',
                         'historical_external_entries'), 0)
    out.update({'failure_'+reason:0 for reason in decoder.REASONS})
    for internal, value in records:
        try:
            require(len(internal) >= 8)
            if internal[-8] != 1:
                continue
            db, store, index, _ = prefix(internal[:-8])
            if not (db and store):
                continue
            if index == 3:
                out['historical_external_entries'] += 1
            if index != 1:
                continue
            out['historical_rows'] += 1
            decoder._decode(value)
            out['historical_decoded'] += 1
        except decoder.External as exc:
            out['historical_external_values'] += 1
            out['failure_'+exc.reason] += 1
        except decoder.Unsupported as exc:
            out['historical_unsupported'] += 1
            out['failure_'+exc.reason] += 1
        except Exception:
            out['historical_invalid'] += 1
    return out

def probe():
    root = Path.home() / "Library/Containers/com.microsoft.teams2"
    result = {"scope": "teams_origin_sstables_only", "logical_snapshot": False,
              "checksums_verified": True, "container_present": root.is_dir(), "wal_read": False, "network_used": False,
              "databases": [], "scan_errors": 0}
    def scan_error(_):
        result["scan_errors"] += 1
    for directory, dirs, files in os.walk(root, followlinks=False, onerror=scan_error):
        dirs[:] = [d for d in dirs if not (Path(directory) / d).is_symlink()]
        path = Path(directory)
        if path.name not in ("https_teams.microsoft.com_0.indexeddb.leveldb", "https_teams.cloud.microsoft_0.indexeddb.leveldb"):
            continue
        records = []
        successful = failed = changed = 0
        for file in files:
            if not file.endswith(".ldb"):
                continue
            try:
                target = path / file
                fd = os.open(target, os.O_RDONLY | os.O_NOFOLLOW)
                with os.fdopen(fd, "rb") as stream:
                    before = os.fstat(stream.fileno())
                    require(before.st_size <= LIMIT)
                    data = stream.read(LIMIT + 1)
                    after = os.fstat(stream.fileno())
                if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
                    changed += 1
                    continue
                parsed = list(table_entries(data))
                records.extend(parsed)
                successful += 1
            except Exception:
                failed += 1
        try:
            summary = summarize(records)
            summary['historical_serialization'] = historical_serialization(records)
        except Exception:
            summary = {"structure_unavailable": True}
        result["databases"].append({"tables_read": successful, "tables_failed": failed,
                                    "tables_changed": changed, **summary})
    return result

if __name__ == "__main__":
    try:
        print(json.dumps(probe(), sort_keys=True))
    except BaseException:
        print('{"probe_failed":true}')
        raise SystemExit(1)
