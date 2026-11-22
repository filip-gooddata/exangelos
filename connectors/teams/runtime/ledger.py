"""Durable, subscription-local reconciliation of Teams observations.

Changed metadata versions and immutable replay edges grow with history. Nothing
is pruned: returning a batch does not acknowledge consumption of its cursor.
Only delivery edges may contain consented message excerpts.
"""
from datetime import datetime, timedelta, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import sys
import uuid


ERROR = 'Teams observation or resume state is unavailable, unsupported, or inconsistent'
TOKEN = re.compile(r'[a-f0-9]{64}\Z')
CURSOR = re.compile(r'4:([a-f0-9]{32}):([a-f0-9]{32})\Z')
SCHEMA = (
    'CREATE TABLE commits (lineage TEXT, id TEXT, scope TEXT NOT NULL, digest TEXT NOT NULL, PRIMARY KEY(lineage,id))',
    'CREATE TABLE versions (sequence INTEGER PRIMARY KEY, lineage TEXT NOT NULL, message TEXT NOT NULL, commit_id TEXT NOT NULL, metadata TEXT NOT NULL, revision INTEGER NOT NULL)',
    'CREATE INDEX latest ON versions(lineage,message,sequence DESC)',
    'CREATE TABLE edges (lineage TEXT, source TEXT, result TEXT NOT NULL, PRIMARY KEY(lineage,source))',
)


class ObservationGap(Exception):
    pass


def require(condition):
    if not condition:
        raise ObservationGap(ERROR)


def token(value):
    return isinstance(value, str) and TOKEN.fullmatch(value) is not None


def packed(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'))


def ledger_path():
    home = os.environ.get('EXANGELOS_HOME')
    root = Path(home) if home else Path(os.environ.get('XDG_DATA_HOME') or Path.home() / '.local/share') / 'exangelos'
    return root / 'connectors/teams/ledger.sqlite3'


CONTEXT = ('conversationLabel', 'messageTime', 'sender', 'permalink')
ACTIONS = {
    'message.new': 'New message', 'message.reply': 'New reply', 'message.edited': 'Message edited',
    'reaction.added': 'Reaction added', 'reaction.removed': 'Reaction removed',
}


def millis(value):
    return type(value) is int and 0 <= value <= 8640000000000000


def utc_stamp(value):
    try:
        stamp = datetime(1970, 1, 1, tzinfo=timezone.utc) + timedelta(milliseconds=value)
        return stamp.isoformat(timespec='milliseconds').replace('+00:00', 'Z')
    except OverflowError:
        return f'{value} ms since Unix epoch UTC'


def wake_summary(kind, payload, observed_at):
    quote = lambda value: json.dumps(value, ensure_ascii=False)
    author = quote(payload['sender']) if 'sender' in payload else 'unknown author'
    if kind in ('message.new', 'message.reply'):
        action = f'{ACTIONS[kind]} by {author}'
    else:
        action = f'{ACTIONS[kind]} (actor unknown, message author: {author})'
    timing = []
    if 'messageTime' in payload:
        timing.append('message time ' + utc_stamp(payload['messageTime']))
    if not timing or kind not in ('message.new', 'message.reply'):
        timing.append('observed ' + utc_stamp(observed_at))
    summary = f"{action} in {quote(payload['conversationLabel'])} ({', '.join(timing)})"
    if 'permalink' in payload:
        summary += ' | ' + payload['permalink']
    if 'preview' in payload:
        summary += ' | Untrusted message excerpt: ' + quote(payload['preview'])
    return summary


def snapshot_metadata(snapshot):
    messages = snapshot.get('messages')
    require(isinstance(messages, list) and len(messages) <= 500)
    normalized = []
    seen = set()
    for message in messages:
        require(isinstance(message, dict))
        require(token(message.get('id')) and token(message.get('body')))
        for field in ('parent', 'reaction'):
            require(field in message and (message[field] is None or token(message[field])))
        reactions = message.get('reactions')
        require('reactions' in message)
        require(reactions is None or (isinstance(reactions, list) and len(reactions) <= 500 and all(token(r) for r in reactions)))
        require(reactions is None or len(set(reactions)) == len(reactions))
        require(message['id'] not in seen)
        seen.add(message['id'])
        for key, limit in [('conversationLabel', 128), ('sender', 80), ('permalink', 512), ('preview', 160)]:
            if key == 'conversationLabel' or key in message:
                value = message.get(key)
                require(isinstance(value, str) and 0 < len(value) <= limit and value.isprintable())
        require('messageTime' not in message or millis(message['messageTime']))
        require(snapshot['includeMessagePreview'] or 'preview' not in message)
        fields = ('id', 'body', 'parent', 'reaction', *CONTEXT)
        entry = {key: message[key] for key in fields if key in message}
        entry['reactions'] = None if reactions is None else sorted(reactions)
        normalized.append(entry)
    normalized.sort(key=lambda m: m['id'])
    return normalized, hashlib.sha256(packed(normalized).encode()).hexdigest()


def open_ledger(path, resume):
    require(not path.resolve().is_relative_to(Path(__file__).resolve().parents[1]))
    require(not path.is_symlink())
    created = False
    if not path.exists():
        require(not resume)
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        try:
            fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            os.close(fd)
            created = True
        except FileExistsError:
            pass
    os.chmod(path.parent, 0o700)
    os.chmod(path, 0o600)
    db = sqlite3.connect(path, isolation_level=None)
    try:
        db.execute('PRAGMA synchronous=FULL')
        db.execute('BEGIN IMMEDIATE')
        if created:
            version = 0
            for statement in SCHEMA:
                db.execute(statement)
        else:
            version = db.execute('PRAGMA user_version').fetchone()[0]
            require(version in (3, 4))
            require(db.execute('PRAGMA quick_check').fetchall() == [('ok',)])
            for table, columns in (('commits', 'lineage,id,scope,digest'),
                                   ('versions', 'sequence,lineage,message,commit_id,metadata,revision'),
                                   ('edges', 'lineage,source,result')):
                db.execute(f'SELECT {columns} FROM {table} LIMIT 0')
        if version < 4:
            db.execute('CREATE TABLE watches (lineage TEXT PRIMARY KEY, started_at INTEGER NOT NULL, previews INTEGER NOT NULL)')
            db.execute('PRAGMA user_version=4')
        return db
    except BaseException:
        db.close()
        raise


def reconcile(request, path=None):
    require(isinstance(request, dict) and isinstance(request.get('snapshot'), dict))
    observed_at = request.get('observedAt')
    require(millis(observed_at))
    snapshot = request['snapshot']
    require(token(snapshot.get('scope')))
    previews = snapshot.get('includeMessagePreview')
    require(type(previews) is bool)
    cursor = request.get('cursor')
    require('cursor' not in request or isinstance(cursor, str))
    match = CURSOR.fullmatch(cursor) if isinstance(cursor, str) else None
    require(cursor is None or match is not None)
    baseline = snapshot_metadata(snapshot) if cursor is None else None
    db = open_ledger(Path(path) if path is not None else ledger_path(), cursor is not None)
    try:
        previous = None
        if match:
            lineage, source = match.groups()
            previous = db.execute('SELECT scope,digest FROM commits WHERE lineage=? AND id=?', (lineage, source)).fetchone()
            require(previous is not None and previous[0] == snapshot['scope'])
            watch = db.execute('SELECT started_at,previews FROM watches WHERE lineage=?', (lineage,)).fetchone()
            require(watch is not None and watch[1] == previews)
            started_at = watch[0]
            edge = db.execute('SELECT result FROM edges WHERE lineage=? AND source=?', (lineage, source)).fetchone()
            if edge:
                result = json.loads(edge[0])
                db.commit()
                return result
        else:
            lineage, source = uuid.uuid4().hex, None
            started_at = request.get('startedAt', observed_at)
            require(millis(started_at) and started_at <= observed_at)
            db.execute('INSERT INTO watches VALUES (?,?,?)', (lineage, started_at, previews))
        messages, digest = baseline if baseline is not None else snapshot_metadata(snapshot)
        if previous and digest == previous[1]:
            db.commit()
            return {'events': [], 'cursor': cursor}
        commit = uuid.uuid4().hex
        result = {'events': [], 'cursor': f'4:{lineage}:{commit}'}
        db.execute('INSERT INTO commits VALUES (?,?,?,?)', (lineage, commit, snapshot['scope'], digest))
        excerpts = {m['id']: m['preview'] for m in snapshot['messages'] if 'preview' in m}
        for message in messages:
            row = db.execute('SELECT metadata,revision FROM versions WHERE lineage=? AND message=? ORDER BY sequence DESC LIMIT 1', (lineage, message['id'])).fetchone()
            old, revision = (json.loads(row[0]), row[1]) if row else (None, 0)
            changes = []
            if previous:
                if old is None:
                    if message.get('messageTime', -1) >= started_at:
                        changes.append(('message.reply' if message['parent'] is not None else 'message.new', 'observed'))
                else:
                    require(old['parent'] == message['parent'])
                    if old['body'] != message['body']:
                        changes.append(('message.edited', message['body']))
                    if old['reactions'] is not None and message['reactions'] is not None:
                        changes.extend(('reaction.added', r) for r in message['reactions'] if r not in old['reactions'])
                        changes.extend(('reaction.removed', r) for r in old['reactions'] if r not in message['reactions'])
            for kind, transition in changes:
                identity = packed([lineage, snapshot['scope'], message['id'], revision, kind, transition])
                payload = {key: message[key] for key in CONTEXT if key in message}
                if kind.startswith('message.') and message['id'] in excerpts:
                    payload['preview'] = excerpts[message['id']]
                result['events'].append({'type': kind, 'occurredAt': observed_at,
                                         'summary': wake_summary(kind, payload, observed_at),
                                         'payload': dict(payload, version=1, count=1, source='native-cache'),
                                         'dedupeKey': 'teams:' + hashlib.sha256(identity.encode()).hexdigest()})
            revision += bool(changes)
            require(revision <= 9007199254740989)
            if old != message:
                db.execute('INSERT INTO versions(lineage,message,commit_id,metadata,revision) VALUES (?,?,?,?,?)', (lineage, message['id'], commit, packed(message), revision))
        if source:
            db.execute('INSERT INTO edges VALUES (?,?,?)', (lineage, source, packed(result)))
        db.commit()
        return result
    finally:
        db.close()


def main():
    os.umask(0o077)
    try:
        text = sys.stdin.buffer.read(4_000_001)
        require(len(text) <= 4_000_000)
        result = reconcile(json.loads(text))
        sys.stdout.write(packed(result) + '\n')
    except Exception:
        sys.stderr.write(ERROR + '\n')
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
