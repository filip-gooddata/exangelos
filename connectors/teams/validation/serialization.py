"""Bounded in-memory IndexedDB analysis. Only analyze() is an output boundary.
Private helpers return sensitive objects: never log, serialize or persist them.
Input must be a single origin's reconciled LevelDB user-key view, not SST rows.
"""
import datetime
import math
import struct
from probe import prefix, snappy, varint

MAX_BYTES = 4 * 1024 * 1024
MAX_ROWS = 100000
MAX_TOTAL = 256 * 1024 * 1024
MAX_NODES = 100000
MAX_DEPTH = 64
CATEGORIES = ('messages', 'message_related', 'conversations', 'threads', 'accounts', 'other', 'unmapped')

class Invalid(Exception):
    def __init__(self):
        super().__init__('invalid_structure')

REASONS = ('sparse_array', 'array_properties', 'map', 'set', 'bigint',
           'boxed', 'regexp', 'array_buffer', 'array_buffer_view', 'shared_or_transfer',
           'error_object', 'unknown_tag', 'blink_trailer', 'external_envelope', 'host_object')
TAG_REASONS = {b'a':'sparse_array', b';':'map', b"'":'set', b'Z':'bigint',
               b'z':'boxed', b'y':'boxed', b'x':'boxed', b'n':'boxed', b's':'boxed',
               b'R':'regexp', b'B':'array_buffer', b'~':'array_buffer',
               b'V':'array_buffer_view', b'u':'shared_or_transfer',
               b't':'shared_or_transfer', b'p':'shared_or_transfer',
               b'w':'shared_or_transfer', b'm':'shared_or_transfer', b'r':'error_object'}

class Unsupported(Invalid):
    def __init__(self, reason='unknown_tag'):
        super().__init__()
        self.reason = reason if reason in REASONS else 'unknown_tag'

class External(Unsupported):
    pass


def need(ok):
    if not ok:
        raise Invalid()


class _SparseArray:
    """Private structural value; intentionally not a message object or IDB key."""
    def __init__(self, length):
        self.length, self.properties = length, {}


class _Collection:
    """Ordered wire entries retain object keys and cycles without hashing them."""
    def __init__(self, kind):
        self.kind, self.items = kind, []


class Reader:
    def __init__(self, data):
        need(type(data) is bytes and len(data) <= MAX_BYTES)
        self.data, self.p, self.nodes, self.refs = data, 0, 0, []

    def take(self, n):
        need(0 <= n <= MAX_BYTES and self.p + n <= len(self.data))
        value = self.data[self.p:self.p+n]
        self.p += n
        return value

    def uint(self):
        try:
            value, self.p = varint(self.data, self.p)
        except Exception:
            raise Invalid() from None
        return value

    def tag(self):
        while True:
            tag = self.take(1)
            if tag != b'\0':
                return tag

    def value(self, depth=0):
        self.nodes += 1
        need(depth <= MAX_DEPTH and self.nodes <= MAX_NODES)
        tag = self.tag()
        if tag in (b'_', b'0', b'-'):
            return None
        if tag in (b'T', b'F'):
            return tag == b'T'
        if tag in (b'I', b'U'):
            n = self.uint()
            need(n < 2**32)
            return (n >> 1) ^ -(n & 1) if tag == b'I' else n
        if tag in (b'N', b'D'):
            n = struct.unpack('<d', self.take(8))[0]
            if tag == b'D':
                n = ('date', n)
                self.refs.append(n)
            return n
        if tag in (b'S', b'"', b'c'):
            raw = self.take(self.uint())
            try:
                return raw.decode({b'S':'utf-8', b'"':'latin1', b'c':'utf-16-le'}[tag])
            except UnicodeError:
                raise Invalid() from None
        if tag == b'^':
            n = self.uint()
            need(n < len(self.refs))
            return self.refs[n]
        if tag in (b';', b"'"):
            obj = _Collection('map' if tag == b';' else 'set')
            self.refs.append(obj)
            end = b':' if tag == b';' else b','
            count = 0
            while True:
                start = self.p
                if self.tag() == end:
                    break
                self.p = start
                item = self.value(depth+1)
                if tag == b';':
                    item = (item, self.value(depth+1))
                obj.items.append(item)
                count += 2 if tag == b';' else 1
            need(self.uint() == count)
            return obj
        if tag in (b'o', b'A', b'a'):
            length = self.uint() if tag != b'o' else 0
            need(length <= MAX_NODES)
            obj = [] if tag == b'A' else _SparseArray(length) if tag == b'a' else {}
            self.refs.append(obj)
            if tag == b'A':
                for _ in range(length):
                    obj.append(self.value(depth+1))
            end = {b'o': b'{', b'A': b'$', b'a': b'@'}[tag]
            count = 0
            while True:
                start = self.p
                if self.tag() == end:
                    break
                self.p = start
                key = self.value(depth+1)
                need(type(key) in (str, int))
                value = self.value(depth+1)
                if tag == b'A':
                    raise Unsupported('array_properties')
                props = obj.properties if tag == b'a' else obj
                if tag == b'a':

                    if type(key) is str and key.isascii() and key.isdigit():
                        if len(key) <= 10 and str(int(key)) == key and int(key) < 2**32-1:
                            key = int(key)
                    if type(key) is int:
                        need(0 <= key < length)
                    need(key != 'length')
                need(key not in props)
                props[key] = value
                count += 1
            need(self.uint() == count)
            if tag != b'o':
                need(self.uint() == length)
            return obj
        if tag == b'\\':
            raise External('host_object')
        raise Unsupported(TAG_REASONS.get(tag, 'unknown_tag'))


def _decode(value):
    """Return a private decoded value; rejects partial/unknown structures."""
    r = Reader(value)
    r.uint()
    data = value[r.p:]
    if data.startswith(b'\xff\x11\x01'):
        raise External('external_envelope')
    if data.startswith(b'\xff\x11\x02'):
        packed = data[3:]
        try:
            size, _ = varint(packed)
            need(size <= MAX_BYTES)
            data = snappy(packed)
        except Exception:
            raise Invalid() from None
    r = Reader(data)
    need(r.take(1) == b'\xff')
    version = r.uint()
    if version >= 16:
        need(version <= 21)
        if version >= 21:
            need(r.take(1) == b'\xfe')

            if r.take(12) != bytes(12):
                raise Unsupported('blink_trailer')
        need(r.take(1) == b'\xff')
        version = r.uint()
    need(13 <= version <= 16)
    obj = r.value()
    need(all(b == 0 for b in r.data[r.p:]))
    return obj


def _idb_key(r, depth=0):
    need(depth <= MAX_DEPTH)
    tag = r.take(1)
    if tag == b'\x01':
        try:
            return r.take(r.uint()*2).decode('utf-16-be')
        except UnicodeError:
            raise Invalid() from None
    if tag in (b'\x02', b'\x03'):
        n = struct.unpack('<d', r.take(8))[0]
        need(math.isfinite(n))
        return ('date', n) if tag == b'\x02' else n
    if tag == b'\x06':
        return r.take(r.uint())
    if tag == b'\x04':
        n = r.uint()
        need(n <= MAX_NODES)
        return [_idb_key(r, depth+1) for _ in range(n)]
    raise Invalid()


def _keypath(data):
    r = Reader(data)
    def string():
        return r.take(r.uint()*2).decode('utf-16-be')
    try:
        if data[:2] != b'\0\0' or len(data) < 3:
            return data.decode('utf-16-be')
        tag = r.take(3)
        if tag == b'\0\0\0':
            result = None
        elif tag == b'\0\0\1':
            result = string()
        elif tag == b'\0\0\2':
            n = r.uint()
            need(n <= MAX_NODES)
            result = [string() for _ in range(n)]
        else:
            raise Invalid()
        need(r.p == len(data))
        return result
    except UnicodeError:
        raise Invalid() from None


def _at(obj, path):
    if type(path) is list:
        return [_at(obj, part) for part in path]
    need(type(path) is str)
    if path == '':
        return obj
    for part in path.split('.'):
        need(type(obj) is dict and part in obj)
        obj = obj[part]
    return obj


def _equal(a, b, depth=0):
    need(depth <= MAX_DEPTH)
    if type(a) is list and type(b) is list:
        return len(a) == len(b) and all(_equal(x,y,depth+1) for x,y in zip(a,b))
    if type(a) not in (str, int, float, bytes, tuple) or type(b) not in (str,int,float,bytes,tuple):
        return False
    return a == b


def _category(raw):
    name = raw.decode('utf-16-be').lower()
    for cat, names in {'messages':('message','messages'), 'conversations':('conversation','conversations','chats'),
                       'threads':('thread','threads'), 'accounts':('account','accounts')}.items():
        if name in names:
            return cat
    return 'message_related' if 'message' in name else 'other'


def _identity(obj):
    if type(obj) is not dict:
        return None
    account, tenant = obj.get('accountId'), obj.get('tenantId')
    if type(account) is str and account and type(tenant) is str and tenant:
        return account, tenant
    return None


def _bind_account(obj, trusted_account, trusted_tenant):
    """Private exact match against a caller-verified anchor; never infer login.

    The caller must establish the anchor's authority separately. A database name,
    sender identity or lone observed account pair is not such an anchor.
    """
    if type(trusted_account) is not str or not trusted_account:
        return False
    if type(trusted_tenant) is not str or not trusted_tenant:
        return False
    return _identity(obj) == (trusted_account, trusted_tenant)


def _timestamp(value):
    if type(value) in (int,float):
        return math.isfinite(value) and 946684800000 <= value <= 4102444800000
    if type(value) is tuple and len(value) == 2 and value[0] == 'date':
        return _timestamp(value[1])
    if type(value) is str and len(value) <= 40:
        try:
            stamp = datetime.datetime.fromisoformat(value.replace('Z','+00:00'))
            return stamp.tzinfo is not None and 2000 <= stamp.year < 2100
        except ValueError:
            pass
    return False


def analyze(current: dict[bytes, bytes]):
    """Static aggregate schema only. Does not establish snapshot freshness or login."""
    names = ('rows', 'invalid', 'metadata', 'decoded', 'unsupported', 'external_values',
             'external_entries', 'objects', 'keypath_matches', 'keypath_mismatches',
             'timestamp_shaped', 'scope_fields', 'account_pairs', 'account_consistent_rows',
             'account_conflicting_rows', 'unmapped_rows')
    out = dict.fromkeys(names, 0)
    out.update({'failure_'+reason:0 for reason in REASONS})
    out.update({cat+'_stores':0 for cat in CATEGORIES})
    out.update({cat+'_rows':0 for cat in CATEGORIES})
    out.update({cat+'_decoded':0 for cat in CATEGORIES})
    out.update(input_bounded=True, account_binding_proven=False, message_semantics_proven=False,
               snapshot_verified=False, external_objects_supported=False)
    if type(current) is not dict or len(current) > MAX_ROWS:
        out['input_bounded'] = False
        return out
    total = 0
    for key,value in current.items():
        if type(key) is not bytes or type(value) is not bytes:
            out['input_bounded'] = False
            return out
        total += len(key)+len(value)
        if total > MAX_TOTAL:
            out['input_bounded'] = False
            return out
    stores, paths, rows = {}, {}, []
    for key,value in current.items():
        out['rows'] += 1
        try:
            need(len(key) <= MAX_BYTES and len(value) <= MAX_BYTES)
            db,store,index,p = prefix(key)
            if db and not store and not index and key[p:p+1] == b'2':
                r = Reader(key[p+1:])
                sid = r.uint()
                kind = r.take(1)
                need(r.p == len(r.data))
                if kind == b'\0':
                    stores[db,sid] = _category(value)
                    out['metadata'] += 1
                elif kind == b'\1':
                    paths[db,sid] = _keypath(value)
                    out['metadata'] += 1
            elif db and store and index == 1:
                rows.append((db,store,key[p:],value))
            elif db and store and index == 3:
                out['external_entries'] += 1
        except Exception:
            out['invalid'] += 1
    for cat in stores.values():
        out[cat+'_stores'] += 1
    pairs = {}
    for db,store,key,value in rows:
        out[stores.get((db,store),'unmapped')+'_rows'] += 1
        try:
            kr = Reader(key)
            primary = _idb_key(kr)
            need(kr.p == len(key))
            obj = _decode(value)
            out['decoded'] += 1
            out[stores.get((db,store),'unmapped')+'_decoded'] += 1
            if type(obj) is not dict:
                continue
            out['objects'] += 1
            path = paths.get((db,store))
            if path is not None:
                try:
                    match = _equal(primary, _at(obj,path))
                except Invalid:
                    match = False
                out['keypath_matches' if match else 'keypath_mismatches'] += 1
            out['timestamp_shaped'] += any(_timestamp(obj.get(k)) for k in ('createdTime','createdDateTime','lastModifiedDateTime','timestamp'))
            out['scope_fields'] += any(type(obj.get(k)) is str and bool(obj[k]) for k in ('conversationId','chatId','threadId','channelId'))
            pair = _identity(obj)
            if pair:
                group = pairs.setdefault(db,{})
                group[pair] = group.get(pair,0)+1
        except External as exc:
            out['external_values'] += 1
            out['failure_'+exc.reason] += 1
        except Unsupported as exc:
            out['unsupported'] += 1
            out['failure_'+exc.reason] += 1
        except Exception:
            out['invalid'] += 1
    out['account_pairs'] = sum(len(group) for group in pairs.values())
    for group in pairs.values():
        out['account_consistent_rows' if len(group)==1 else 'account_conflicting_rows'] += sum(group.values())
    return out
