"""Durable, subscription-local reconciliation of privately keyed Teams metadata.

Changed metadata versions and immutable replay edges grow with history. Nothing
is pruned: returning a batch does not acknowledge consumption of its cursor.
"""
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
CURSOR = re.compile(r'3:([a-f0-9]{32}):([a-f0-9]{32})\Z')
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


def snapshot_metadata(snapshot):
    messages = snapshot.get('messages')
    require(isinstance(messages, list) and 1 <= len(messages) <= 500)
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
        normalized.append({key: message[key] for key in ('id', 'body', 'parent', 'reaction')} | {'reactions': None if reactions is None else sorted(reactions)})
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
            for statement in SCHEMA:
                db.execute(statement)
            db.execute('PRAGMA user_version=3')
        else:
            require(db.execute('PRAGMA user_version').fetchone()[0] == 3)
            require(db.execute('PRAGMA quick_check').fetchall() == [('ok',)])
            for table, columns in (('commits', 'lineage,id,scope,digest'),
                                   ('versions', 'sequence,lineage,message,commit_id,metadata,revision'),
                                   ('edges', 'lineage,source,result')):
                db.execute(f'SELECT {columns} FROM {table} LIMIT 0')
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
            previous = db.execute('SELECT scope,digest FROM commits WHERE lineage=? AND id=?', (lineage, source)).fetchone()
            require(previous is not None and previous[0] == snapshot['scope'])
            edge = db.execute('SELECT result FROM edges WHERE lineage=? AND source=?', (lineage, source)).fetchone()
            if edge:
                result = json.loads(edge[0])
                db.commit()
                return result
        else:
            lineage, source = uuid.uuid4().hex, None
        messages, digest = baseline if baseline is not None else snapshot_metadata(snapshot)
        if previous and digest == previous[1]:
            db.commit()
            return {'events': [], 'cursor': cursor}
        commit = uuid.uuid4().hex
        result = {'events': [], 'cursor': f'3:{lineage}:{commit}'}
        db.execute('INSERT INTO commits VALUES (?,?,?,?)', (lineage, commit, snapshot['scope'], digest))
        for message in messages:
            row = db.execute('SELECT metadata,revision FROM versions WHERE lineage=? AND message=? ORDER BY sequence DESC LIMIT 1', (lineage, message['id'])).fetchone()
            old, revision = (json.loads(row[0]), row[1]) if row else (None, 0)
            changes = []
            if previous:
                if old is None:
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
                result['events'].append({'type': kind, 'occurredAt': observed_at, 'dedupeKey': 'teams:' + hashlib.sha256(identity.encode()).hexdigest()})
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
