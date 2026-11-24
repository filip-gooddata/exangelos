"""Durable, subscription-local reconciliation of privately keyed Slack metadata.

Changed metadata versions and immutable replay edges grow with history. Nothing
is pruned: returning a batch does not acknowledge consumption of its cursor.
"""
from datetime import datetime, timedelta, timezone
from decimal import Decimal
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import sys
import uuid

from observation import safe_name
from state_directory import state_directory


ERROR = 'Slack observation or cursor is incomplete, unsupported, or inconsistent'
TOKEN = re.compile(r'[a-f0-9]{64}\Z')
GENERATION = re.compile(r'(0|[1-9][0-9]{0,19})\Z')
CURSOR = re.compile(r'4:([a-f0-9]{32}):([a-f0-9]{32})\Z')
SCHEMA = (
    'CREATE TABLE commits (lineage TEXT, id TEXT, scope TEXT NOT NULL, generation TEXT NOT NULL, snapshot TEXT NOT NULL, digest TEXT NOT NULL, PRIMARY KEY(lineage,id))',
    'CREATE TABLE versions (sequence INTEGER PRIMARY KEY, lineage TEXT NOT NULL, message TEXT NOT NULL, commit_id TEXT NOT NULL, metadata TEXT NOT NULL, revision INTEGER NOT NULL)',
    'CREATE INDEX latest ON versions(lineage,message,sequence DESC)',
    'CREATE TABLE edges (lineage TEXT, source TEXT, result TEXT NOT NULL, PRIMARY KEY(lineage,source))',
)


FLOORS = "CREATE TABLE watch_starts (lineage TEXT PRIMARY KEY, millis INTEGER NOT NULL)"


class LegacyCursor(Exception):
    pass


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
    path = state_directory() / 'ledger.sqlite3'
    installed = Path(__file__).resolve().parent.parent
    require(not path.resolve().is_relative_to(installed))
    return path


ACTIONS = {
    'message.new': 'New message', 'thread.reply': 'Thread reply', 'message.edited': 'Message edited',
    'reaction.added': 'Reaction added', 'reaction.removed': 'Reaction removed',
}


def utc_stamp(seconds, fraction):
    try:
        instant = datetime(1970, 1, 1, tzinfo=timezone.utc) + timedelta(seconds=int(seconds))
        return f'{instant:%Y-%m-%d %H:%M:%S}.{fraction} UTC'
    except OverflowError:
        return f'{seconds}.{fraction} seconds since Unix epoch UTC'


def wake_summary(kind, payload, observed_at):
    when = utc_stamp(*payload['messageTs'].split('.'))
    quote = lambda value: json.dumps(value, ensure_ascii=False)
    author = quote(payload['sender']) if 'sender' in payload else 'unknown author'
    if kind in ('message.new', 'thread.reply'):
        action = f'{ACTIONS[kind]} by {author}'
        timing = f'message time {when}'
    else:
        action = f'{ACTIONS[kind]} (message author: {author})'
        seconds, millis = divmod(observed_at, 1000)
        timing = f"message time {when}, observed {utc_stamp(seconds, f'{millis:03d}')}"
    summary = f"{action} in {quote(payload['conversationLabel'])} ({timing})"
    if 'preview' in payload:
        summary += ' | Untrusted message excerpt: ' + quote(payload['preview'])
    return summary


def snapshot_metadata(snapshot):
    require(snapshot.get('complete') is True)
    require(isinstance(snapshot.get('generation'), str) and GENERATION.fullmatch(snapshot['generation']))
    require(token(snapshot.get('snapshot')))
    messages = snapshot.get('messages')
    require(isinstance(messages, list) and len(messages) <= 500)
    normalized = []
    seen = set()
    for message in messages:
        require(isinstance(message, dict))
        require(token(message.get('id')) and token(message.get('body')))
        require(type(message.get('reply')) is bool and type(message.get('reactionsComplete')) is bool)
        reactions = message.get('reactions')
        require(isinstance(reactions, list) and len(reactions) <= 100 and all(token(r) for r in reactions))
        require(len(set(reactions)) == len(reactions) and message['id'] not in seen)
        seen.add(message['id'])
        if 'preview' in message:
            preview = message['preview']
            require(isinstance(preview, str) and 0 < len(preview) <= 160 and preview.isprintable())
        for field in ('memberSender', 'memberPeer'):
            if field in message:
                require(safe_name(message[field]))
        timestamp = message.get('messageTs')
        require(isinstance(timestamp, str) and re.fullmatch(r'[0-9]{1,20}\.[0-9]{1,10}', timestamp))
        for field, limit in [('conversationLabel', 128), ('permalink', 512), ('sender', 80)]:
            if field == 'sender' and field not in message:
                continue
            value = message.get(field)
            require(isinstance(value, str) and 0 < len(value) <= limit and value.isprintable())
        fields = ('id', 'body', 'reply', 'reactionsComplete', 'messageTs', 'conversationLabel', 'permalink')
        entry = {field: message[field] for field in fields}
        if 'sender' in message:
            entry['sender'] = message['sender']
        entry['reactions'] = sorted(reactions)
        normalized.append(entry)
    normalized.sort(key=lambda m: m['id'])
    return normalized, hashlib.sha256(packed(normalized).encode()).hexdigest()


def legacy_context_matches(db, lineage, messages, old_digest):
    # 0.3.0 included display metadata in its digest. Reconstruct that exact
    # digest with the committed labels when 0.4.0 suppresses an unsafe name.
    if not token(old_digest):
        return False
    rows = []
    for message in messages:
        row = db.execute('SELECT metadata FROM versions WHERE lineage=? AND message=? ORDER BY sequence DESC LIMIT 1',
                         (lineage, message['id'])).fetchone()
        if row is None:
            return False
        old = json.loads(row[0])
        candidate = dict(message)
        for field in ('sender', 'conversationLabel', 'permalink'):
            candidate.pop(field, None)
            if field in old:
                candidate[field] = old[field]
        rows.append(candidate)
    return rows != messages and hashlib.sha256(packed(rows).encode()).hexdigest() == old_digest


def open_ledger(path, resume, *, check_integrity=True):
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
            for statement in SCHEMA:
                db.execute(statement)
            db.execute(FLOORS)
            db.execute('PRAGMA user_version=5')
        else:
            version = db.execute('PRAGMA user_version').fetchone()[0]
            require(version in (4, 5))
            if check_integrity:
                require(db.execute('PRAGMA quick_check').fetchall() == [('ok',)])
            for table, columns in (('commits', 'lineage,id,scope,generation,snapshot,digest'),
                                   ('versions', 'sequence,lineage,message,commit_id,metadata,revision'),
                                   ('edges', 'lineage,source,result')):
                db.execute(f'SELECT {columns} FROM {table} LIMIT 0')
            if version == 4:
                db.execute(FLOORS)
                db.execute('PRAGMA user_version=5')
        db.execute("CREATE TABLE IF NOT EXISTS early (lineage TEXT, message TEXT, PRIMARY KEY(lineage,message))")
        return db
    except BaseException:
        db.close()
        raise


def reconcile(request, path=None):
    require(isinstance(request, dict) and isinstance(request.get('snapshot'), dict))
    observed_at = request.get('observedAt')
    require(type(observed_at) is int and 0 <= observed_at <= 8640000000000000)
    snapshot = request['snapshot']
    require(token(snapshot.get('scope')))
    cursor = request.get('cursor')
    require('cursor' not in request or isinstance(cursor, str))
    match = CURSOR.fullmatch(cursor) if isinstance(cursor, str) else None
    require(cursor is None or match is not None)
    notice = request.get('notification')
    require(notice is None or match is not None)
    baseline = snapshot_metadata(snapshot) if cursor is None else None
    db = open_ledger(Path(path) if path is not None else ledger_path(), cursor is not None,
                     check_integrity=notice is None)
    try:
        previous = None
        if match:
            lineage, source = match.groups()
            previous = db.execute('SELECT scope,generation,snapshot,digest FROM commits WHERE lineage=? AND id=?', (lineage, source)).fetchone()
            require(previous is not None and previous[0] == snapshot['scope'])
            edge = db.execute('SELECT result FROM edges WHERE lineage=? AND source=?', (lineage, source)).fetchone()
            if edge:
                result = json.loads(edge[0])
                if request.get('retryObservation'):
                    successor = CURSOR.fullmatch(result['cursor'])
                    generation, = db.execute('SELECT generation FROM commits WHERE lineage=? AND id=?',
                                              successor.groups()).fetchone()
                    if notice is not None or int(snapshot['generation']) > int(generation):
                        result['retryObservation'] = True
                db.commit()
                return result
            row = db.execute('SELECT millis FROM watch_starts WHERE lineage=?', (lineage,)).fetchone()
            if row is None:
                raise LegacyCursor()
            start_ms = row[0]
        else:
            lineage, source = uuid.uuid4().hex, None
            start_ms = request.get('startedAt', observed_at)
            require(type(start_ms) is int and 0 <= start_ms <= observed_at)
            db.execute('INSERT INTO watch_starts VALUES (?,?)', (lineage, start_ms))
        start = Decimal(start_ms).scaleb(-3)
        if notice is not None:
            message = notice['id']
            require(token(message) and type(notice['reply']) is bool)
            known = db.execute('SELECT 1 FROM versions WHERE lineage=? AND message=? LIMIT 1', (lineage, message)).fetchone()
            if (known or Decimal(notice['messageTs']) < start or
                    not db.execute('INSERT OR IGNORE INTO early VALUES (?,?)', (lineage, message)).rowcount):
                db.commit()
                return {'events': [], 'cursor': cursor}
            commit = uuid.uuid4().hex
            kind = 'thread.reply' if notice['reply'] else 'message.new'
            identity = packed([lineage, previous[0], message, 0, kind, 'created'])
            payload = {field: notice[field] for field in ('messageTs', 'conversationLabel', 'permalink')}
            event = dict(type=kind, occurredAt=observed_at, payload=dict(payload, version=1, count=1),
                         summary=wake_summary(kind, payload, observed_at),
                         dedupeKey='slack:' + hashlib.sha256(identity.encode()).hexdigest())
            result = dict(events=[event], cursor=f'4:{lineage}:{commit}')
            db.execute('INSERT INTO commits VALUES (?,?,?,?,?,?)', (lineage, commit, *previous))
            db.execute('INSERT INTO edges VALUES (?,?,?)', (lineage, source, packed(result)))
            db.commit()
            return result
        messages, digest = baseline if baseline is not None else snapshot_metadata(snapshot)
        if previous:
            require(int(snapshot['generation']) >= int(previous[1]))
            if snapshot['generation'] == previous[1]:
                unchanged = snapshot['snapshot'] == previous[2] and previous[3] in (digest, '2:' + digest)
                require(unchanged or legacy_context_matches(db, lineage, messages, previous[3]))
                db.commit()
                return {'events': [], 'cursor': cursor}
        # Previews belong only to eligible delivery edges, never to baselines or version history.
        delivery = {row['id']: row for row in snapshot['messages']}
        commit = uuid.uuid4().hex
        result = {'events': [], 'cursor': f'4:{lineage}:{commit}'}
        db.execute('INSERT INTO commits VALUES (?,?,?,?,?,?)', (lineage, commit, snapshot['scope'], snapshot['generation'], snapshot['snapshot'], '2:' + digest))
        # snapshot_metadata supplies message-id order for equal numeric times.
        for message in sorted(messages, key=lambda entry: Decimal(entry['messageTs'])):
            row = db.execute('SELECT metadata,revision FROM versions WHERE lineage=? AND message=? ORDER BY sequence DESC LIMIT 1', (lineage, message['id'])).fetchone()
            old, revision = (json.loads(row[0]), row[1]) if row else (None, 0)
            changes = []
            early = False
            if previous:
                if old is None:
                    early = db.execute('DELETE FROM early WHERE lineage=? AND message=?', (lineage, message['id'])).rowcount
                    if not early and Decimal(message['messageTs']) >= start:
                        changes.append(('thread.reply' if message['reply'] else 'message.new', 'created'))
                else:
                    require(old['reply'] == message['reply'])
                    if old['body'] != message['body']:
                        changes.append(('message.edited', message['body']))
                    if old['reactionsComplete'] and message['reactionsComplete']:
                        changes.extend(('reaction.added', r) for r in message['reactions'] if r not in old['reactions'])
                        changes.extend(('reaction.removed', r) for r in old['reactions'] if r not in message['reactions'])
            for kind, transition in changes:
                identity = packed([lineage, snapshot['scope'], message['id'], revision, kind, transition])
                payload = {field: message[field] for field in ('messageTs', 'conversationLabel', 'permalink', 'sender')
                           if field in message}
                context = delivery[message['id']]
                if 'memberSender' in context:
                    payload['sender'] = context['memberSender']
                if 'memberPeer' in context:
                    payload['conversationLabel'] = 'Slack DM with ' + context['memberPeer']
                if kind in ('message.new', 'thread.reply', 'message.edited') and 'preview' in context:
                    payload['preview'] = context['preview']
                result['events'].append({'type': kind, 'occurredAt': observed_at, 'summary': wake_summary(kind, payload, observed_at),
                                         'dedupeKey': 'slack:' + hashlib.sha256(identity.encode()).hexdigest(),
                                         'payload': dict(payload, version=1, count=1)})
            revision += bool(changes or early)
            require(revision < 9007199254740990)
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
        text = sys.stdin.buffer.read(5_000_001)
        require(len(text) <= 5_000_000)
        result = reconcile(json.loads(text))
        sys.stdout.buffer.write(json.dumps(result, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode('utf-8') + b'\n')
    except LegacyCursor:
        return 27
    except Exception:
        sys.stderr.write(ERROR + '\n')
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
