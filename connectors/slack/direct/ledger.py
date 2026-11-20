"""Durable, subscription-local reconciliation of privately keyed Slack metadata.

Changed metadata versions and immutable replay edges grow with history. Nothing
is pruned: returning a batch does not acknowledge consumption of its cursor.
"""
from decimal import Decimal
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import sys
import uuid

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
        normalized.append({key: message[key] for key in ('id', 'body', 'reply', 'reactionsComplete')} | {'reactions': sorted(reactions)})
    normalized.sort(key=lambda m: m['id'])
    return normalized, hashlib.sha256(packed(normalized).encode()).hexdigest()


def open_ledger(path, resume):
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
            require(db.execute('PRAGMA quick_check').fetchall() == [('ok',)])
            for table, columns in (('commits', 'lineage,id,scope,generation,snapshot,digest'),
                                   ('versions', 'sequence,lineage,message,commit_id,metadata,revision'),
                                   ('edges', 'lineage,source,result')):
                db.execute(f'SELECT {columns} FROM {table} LIMIT 0')
            if version == 4:
                db.execute(FLOORS)
                db.execute('PRAGMA user_version=5')
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
    baseline = snapshot_metadata(snapshot) if cursor is None else None
    db = open_ledger(Path(path) if path is not None else ledger_path(), cursor is not None)
    try:
        previous = None
        if match:
            lineage, source = match.groups()
            previous = db.execute('SELECT scope,generation,snapshot,digest FROM commits WHERE lineage=? AND id=?', (lineage, source)).fetchone()
            require(previous is not None and previous[0] == snapshot['scope'])
            edge = db.execute('SELECT result FROM edges WHERE lineage=? AND source=?', (lineage, source)).fetchone()
            if edge:
                result = json.loads(edge[0])
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
        messages, digest = baseline if baseline is not None else snapshot_metadata(snapshot)
        if previous:
            require(int(snapshot['generation']) >= int(previous[1]))
            if snapshot['generation'] == previous[1]:
                require(snapshot['snapshot'] == previous[2] and digest == previous[3])
                db.commit()
                return {'events': [], 'cursor': cursor}
        commit = uuid.uuid4().hex
        result = {'events': [], 'cursor': f'4:{lineage}:{commit}'}
        db.execute('INSERT INTO commits VALUES (?,?,?,?,?,?)', (lineage, commit, snapshot['scope'], snapshot['generation'], snapshot['snapshot'], digest))
        for message in messages:
            row = db.execute('SELECT metadata,revision FROM versions WHERE lineage=? AND message=? ORDER BY sequence DESC LIMIT 1', (lineage, message['id'])).fetchone()
            old, revision = (json.loads(row[0]), row[1]) if row else (None, 0)
            changes = []
            if previous:
                if old is None:
                    if Decimal(message['messageTs']) >= start:
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
                result['events'].append({'type': kind, 'occurredAt': observed_at, 'dedupeKey': 'slack:' + hashlib.sha256(identity.encode()).hexdigest()})
            revision += bool(changes)
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
        text = sys.stdin.buffer.read(4_000_001)
        require(len(text) <= 4_000_000)
        result = reconcile(json.loads(text))
        sys.stdout.write(packed(result) + '\n')
    except LegacyCursor:
        return 2
    except Exception:
        sys.stderr.write(ERROR + '\n')
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
