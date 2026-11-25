"""Decode allowlisted Teams manager stores. All inputs, including names, are untrusted."""
from datetime import datetime
import hashlib
import hmac
from html.parser import HTMLParser
from pathlib import Path
import sys
import json
import re
import unicodedata
from urllib.parse import parse_qsl, quote, unquote, urlencode, urlsplit

# Source checkouts share the renderer; installed bundles carry it in dist.
connector_dir = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(connector_dir.parent / 'shared' if (connector_dir / 'package.json').is_file() else connector_dir / 'dist'))
from excerpt import finish_excerpt

import reactions
import serialization as ser
from probe import prefix

GUID = r'[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}'
DATABASE = re.compile(rf'Teams:(replychain-manager|conversation-manager):react-web-client:({GUID}):(?:8:orgid:)?({GUID}):([a-zA-Z0-9-]{{1,32}})')
CHAT = re.compile(r'19:[A-Za-z0-9._+=/-]{1,400}@(thread\.(?:v2|tacv2|skype)|unq\.gbl\.spaces)')
MESSAGE = re.compile(r'[0-9]{1,20}')


class Refusal(ValueError):
    def __init__(self, code):
        self.code = code


def check(ok, code=21):
    if not ok:
        raise Refusal(code)


def token(key, *parts):
    data = json.dumps(parts, separators=(',', ':'), ensure_ascii=True).encode()
    return hmac.new(key, data, hashlib.sha256).hexdigest()


def reference(value, scope):
    check(isinstance(value, str) and 0 < len(value) <= 4096 and value.isprintable()
          and value == value.strip() and scope in (None, 'conversation', 'replies'), 20)
    check(not MESSAGE.fullmatch(value), 29)
    mid = None
    query = {}
    if CHAT.fullmatch(value):
        chat = value
    else:
        link = urlsplit(value)
        check(link.scheme == 'https' and link.netloc in ('teams.microsoft.com', 'teams.cloud.microsoft')
              and not link.fragment, 20)
        parts = link.path.strip('/').split('/')
        check(len(parts) == 4 and parts[0] == 'l' and parts[1] in ('chat', 'channel', 'message'), 20)
        kind, chat, tail = parts[1], unquote(parts[2]), unquote(parts[3])
        check(CHAT.fullmatch(chat), 20)
        check(kind == 'message' or ((kind == 'channel') == is_channel(chat)), 20)
        check(kind != 'chat' or tail == 'conversations', 20)
        for k, v in parse_qsl(link.query, keep_blank_values=True, max_num_fields=24):
            check(k not in query and k in ('tenantId','groupId','parentMessageId','teamName','channelName',
                                          'createdTime','context','ngc','allowXTenantAccess'), 20)
            query[k] = v
        if 'context' in query:
            try:
                context = json.loads(query['context'])
            except ValueError:
                raise Refusal(20) from None
            check(context == {'contextType':'channel' if is_channel(chat) else 'chat'}, 20)
        if kind == 'message':
            check(MESSAGE.fullmatch(tail), 20)
            check(scope is not None, 27)
            mid = tail
    tenant, group, parent = (query.get(k) for k in ('tenantId','groupId','parentMessageId'))
    check(all(v is None or re.fullmatch(GUID, v) for v in (tenant, group)), 20)
    check(parent is None or (mid and MESSAGE.fullmatch(parent)), 20)
    check(scope != 'replies' or (mid and is_channel(chat)), 28)
    return chat, mid, scope == 'replies', tenant.lower() if tenant else None, group, parent


def is_channel(chat):
    return chat.endswith(('@thread.tacv2', '@thread.skype'))


def stores(view):
    names, tables, paths, data = {}, {}, {}, {}
    for raw, value in view.items():
        db, store, index, pos = prefix(raw)
        tail = raw[pos:]
        if db == store == index == 0 and tail.startswith(b'\xc9'):
            reader = ser.Reader(tail[1:])
            reader.take(reader.uint()*2)
            name = reader.take(reader.uint()*2).decode('utf-16-be')
            check(reader.p == len(reader.data) and 1 <= len(value) <= 8)
            names.setdefault(int.from_bytes(value, 'little'), set()).add(name)
        elif db and not store and not index and tail == b'\1':
            names.setdefault(db, set()).add(value.decode('utf-16-be'))
        elif db and not store and not index and tail.startswith(b'2'):
            reader = ser.Reader(tail[1:])
            sid, kind = reader.uint(), reader.take(1)
            check(reader.p == len(reader.data))
            if kind == b'\0':
                tables[db, sid] = value.decode('utf-16-be')
            elif kind == b'\1':
                paths[db, sid] = value
        elif db and store and index == 1:
            data.setdefault((db, store), []).append((tail, value))
    result = []
    for (db, store), table in tables.items():
        if table not in ('replychains-2', 'conversations'):
            continue
        candidates = names.get(db, ())
        check(len(candidates) == 1, 23)
        match = DATABASE.fullmatch(next(iter(candidates)))
        check(match, 23)
        manager, tenant, user, locale = match.groups()
        check((table == 'replychains-2') == (manager == 'replychain-manager'))
        compound = (table == 'replychains-2' and (db, store) in paths and
                    ser._keypath(paths[db, store]) == ['conversationId', 'replyChainId'])
        records = []
        for key, raw in data.get((db, store), []):
            primary = None
            if compound:
                reader = ser.Reader(key)
                primary = ser._idb_key(reader)
                check(reader.p == len(key) and type(primary) is list and len(primary) == 2
                      and type(primary[0]) is str)
            records.append((primary, raw))
        result.append((table, [tenant.lower(), user.lower(), locale, db, store], records))
    check(any(table == 'replychains-2' for table, _, _ in result))
    return result


def identifier(v):
    if type(v) is float:
        check(v.is_integer() and 0 <= v < 2**53)
        v = int(v)
    if type(v) is int:
        v = str(v)
    check(type(v) is str and MESSAGE.fullmatch(v))
    return v


def mapped_identity(key, node, chat):
    if type(node) is not dict or node.get('conversationId', chat) != chat:
        return None
    try:
        identity = identifier(node.get('id'))
    except Refusal:
        return None
    try:
        numeric = identifier(key)
    except Refusal:
        # Current clients can index a message by its opaque dedupe key.
        if (type(key) is str and 0 < len(key) <= 512 and key.isprintable()
                and node.get('dedupeKey') == key and node.get('conversationId') == chat):
            return identity
        return None
    return identity if numeric == identity else None


def messages(records, chat, root_filter=None, lookup=None):
    rows = {}
    for primary, raw in records:
        if primary and (primary[0] != chat or
                        (root_filter and identifier(primary[1]) != root_filter)):
            continue
        chain = ser._decode(raw)
        check(type(chain) is dict and type(chain.get('conversationId')) is str)
        if primary:
            check(primary[0] == chain['conversationId'] and
                  identifier(primary[1]) == identifier(chain.get('replyChainId')))
        if chain['conversationId'] != chat:
            continue
        root = chain.get('replyChainId')
        if root is not None:
            root = identifier(root)
            if root_filter and root != root_filter:
                continue
        entries = chain.get('messageMap')
        check(type(entries) is dict and entries)
        for mid, node in entries.items():
            identity = mapped_identity(mid, node, chat)
            if identity is None or (lookup and identity != lookup):
                continue
            explicit = node.get('parentMessageId')
            if explicit not in (None, ''):
                explicit = identifier(explicit)
            parent = None
            if is_channel(chat):
                check(explicit or root, 28)
                check(not explicit or not root or explicit == root)
                parent = explicit or root
                if parent == identity:
                    parent = None
            if root_filter and (parent or identity) != root_filter:
                continue
            check(identity not in rows or rows[identity] == (parent, node))
            rows[identity] = parent, node
            check(len(rows) <= 500)
    return rows


# Preserve the existing restrictions on metadata used as display labels.
SENSITIVE = re.compile(
    r'token|key|secret|passw|auth|cookie|bearer|\bbasic\b|session|credential|signature|sig=|'
    r'redact|\[(?:removed|deleted|hidden)\]|[•●█]{2,}|passcode|passwd|private[ _-]*key|otp\b|webhook|xox[a-z]-|xapp-|gh[pousr]_|github_pat_|sk-|AKIA|ASIA|eyJ|'
    r'[a-z0-9_+/=-]{32,}|[0-9]{6,}|[<>`=]|://|www\.|[?&]\w+=|'
    r'@(?:channel|here|everyone)\b|&(?:lt|gt);|\b[\w-]+\.(?:[a-z]{2,})[/#?]|(?:\*{3,}|█)', re.IGNORECASE | re.ASCII)


def safe_text(value):
    return value.isprintable() and not SENSITIVE.search(unicodedata.normalize('NFKC', value))


def label(value):
    return value if type(value) is str and value == value.strip() and 0 < len(value) <= 80 and safe_text(value) else None


# Formatting declarations with explicit, opaque values. Other styles can hide
# text (directly or through the cascade), so omit their subtrees.
FORMAT_STYLE = re.compile(
    r'color\s*:\s*(?:#[a-f0-9]{3}(?:[a-f0-9]{3})?|rgb\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*\)|'
    r'black|white|red|green|blue|purple|orange|gray|grey|yellow)|'
    r'font-weight\s*:\s*(?:normal|bold|bolder|lighter|[1-9]00)|font-style\s*:\s*(?:normal|italic|oblique)',
    re.I | re.ASCII)
HIDDEN_CLASS = re.compile(r'hidden|invisible|sr[-_]?only|screen[-_]?reader|visually[-_]?hide|d-none', re.I)


def visible_attribute(tag, key, value):
    if key == 'class':
        return not HIDDEN_CLASS.search(value or '')
    if key == 'style':
        return all(FORMAT_STYLE.fullmatch(part.strip()) for part in (value or '').split(';') if part.strip())
    if key == 'aria-hidden':
        return (value or '').lower() == 'false'
    return key == 'title' or (tag == 'a' and key in ('href', 'target', 'rel'))


class VisibleHtml(HTMLParser):
    inline = {'b', 'i', 'u', 'em', 'strong', 's', 'code', 'span', 'a'}
    block = {'p', 'div', 'pre', 'ol', 'ul', 'li'}
    void = {'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'}

    def __init__(self):
        super().__init__()
        self.stack = []
        self.parts = []
        self.valid = True

    def handle_starttag(self, tag, attrs):
        if tag == 'style' or (tag == 'link' and any(
                key == 'rel' and 'stylesheet' in (value or '').lower().split() for key, value in attrs)):
            self.valid = False
        if tag in self.void:
            if tag in ('br', 'hr'):
                self.handle_data(' ')
            return
        visible = (not self.stack or self.stack[-1][1]) and (
            tag in self.inline or tag in self.block) and all(
            visible_attribute(tag, key, value) for key, value in attrs)
        self.stack.append((tag, visible))
        if tag in self.block:
            self.handle_data(' ')

    def handle_startendtag(self, tag, attrs):
        if tag not in self.void:
            self.valid = False
        else:
            self.handle_starttag(tag, attrs)

    def handle_endtag(self, tag):
        if not self.stack or self.stack[-1][0] != tag:
            self.valid = False
            return
        if tag in self.block:
            self.handle_data(' ')
        self.stack.pop()

    def handle_data(self, data):
        if not self.stack or self.stack[-1][1]:
            self.parts.append(data)


def preview(node):
    props = node.get('properties', {})
    kind = node.get('messageType')
    if (type(props) is not dict or kind not in (None, 'Text', 'RichText/Html')
            or node.get('deletionInfo') is not None
            or any(node.get(f) for f in ('deleted','redacted','isDeleted','isRedacted','tombstone','hidden','isHidden'))
            or any(props.get(f) for f in ('deletetime','redacted','deleted','hidden','isHidden'))):
        return None
    content = node['content']
    if kind == 'RichText/Html' or (kind is None and re.search(r'<[!/?a-zA-Z]', content)):
        parser = VisibleHtml()
        try:
            parser.feed(content)
            if parser.rawdata or parser.stack or not parser.valid:
                return None
            parser.close()
        except (AssertionError, ValueError):
            return None
        content = ''.join(parser.parts)
    return finish_excerpt(content) or None


def original_time(value):
    if isinstance(value, str) and re.fullmatch(r'[0-9]{12,13}', value):
        value = int(value)
    if not ser._timestamp(value):
        return None
    if isinstance(value, str):
        return int(datetime.fromisoformat(value.replace('Z','+00:00')).timestamp() * 1000)
    if isinstance(value, tuple):
        value = value[1]
    return int(value)


def conversation_metadata(tables, partition, chat):
    metadata = []
    for table, binding, records in tables:
        if table != 'conversations' or partition[:3] != binding[:3]:
            continue
        for _, raw in records:
            row = ser._decode(raw)
            check(type(row) is dict)
            if row.get('id') != chat:
                continue
            title, thread = row.get('chatTitle'), row.get('threadProperties')
            thread = thread if type(thread) is dict else {}
            short = title.get('shortTitle') if type(title) is dict else title
            name = label(short) or label(thread.get('topic')) or label(thread.get('topicThreadTopic'))
            if not name and type(row.get('members')) is list:
                others = [label(m.get('friendlyName')) or label(m.get('displayName')) for m in row['members']
                          if type(m) is dict and m.get('id') and m['id'] != '8:orgid:'+partition[1]]
                if others and all(others):
                    name = label(', '.join(others))
            if not name and type(title) is dict:
                name = label(title.get('longTitle'))
            group = row.get('groupId') or thread.get('groupId') or row.get('teamId')
            metadata.append((name, group.lower() if type(group) is str and re.fullmatch(GUID,group) else None))
    check(len(set(metadata)) <= 1, 23)
    return metadata[0] if metadata else (None, None)


def snapshot_rows(key, pin, rows, name, group, consent):
    chat, root = pin['chat'], pin['root']
    result = []
    for mid, (parent, node) in rows.items():
        if root and root != parent:
            continue
        body = node.get('content')
        check(type(body) is str and len(body.encode()) <= 65536)
        members = reactions.members(node)
        opaque = None if members is None else sorted(token(key, 'reaction', *pair) for pair in members)
        query = {'tenantId':pin['partition'][0]}
        if is_channel(chat):
            query['parentMessageId'] = parent or mid
            if group:
                query['groupId'] = group
        else:
            query['context'] = '{"contextType":"chat"}'
        link = 'https://teams.microsoft.com/l/message/' + quote(chat, safe='') + '/' + mid + '?' + urlencode(query)
        row = {'id':token(key,'id',mid), 'parent':token(key,'id',parent) if parent else None,
               'reaction':token(key,'members',opaque) if opaque is not None else None,
               'reactions':opaque, 'body':token(key,'body',body), 'conversationLabel':name}
        if len(link) <= 512:
            row['permalink'] = link
        for field, value in [('sender', label(node.get('imDisplayName')) or label(node.get('fromDisplayNameInToken'))),
                             ('messageTime', original_time(node.get('originalArrivalTime'))),
                             ('preview', preview(node) if consent else None)]:
            if value is not None:
                row[field] = value
        result.append(row)
    return sorted(result, key=lambda row: row['id'])
