"""Follow only new, fully framed message notifications for a reopened private selection."""
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys
import time

import observation
import source


HEADER = re.compile(rb'^\[\d{2}/\d{2}/\d{2}, \d{2}:\d{2}:\d{2}:\d{3}\] info: Store: NEW_NOTIFICATION *$')
STAMP = re.compile(r'[0-9]{10}\.[0-9]{6}')
LIMIT = 65536


def project(record, request, label, floor):
    selected = request['selection']
    team, account = selected['workspace'], selected['owner']
    identifier = record.get('id')
    if not isinstance(identifier, str):
        return
    parts = identifier.split('|')
    if len(parts) not in (4, 5):
        return
    workspace, kind, channel, ts = parts[:4]
    thread = parts[4] if len(parts) == 5 else None
    if (workspace != team or kind != 'msg' or record.get('teamId') != team
            or record.get('userId') != account or channel not in selected['conversations']
            or record.get('channel') != channel or record.get('msg') != ts
            or not STAMP.fullmatch(ts) or not floor <= int(ts.replace('.', '')) <= time.time_ns() // 1000
            or record.get('thread_ts') != thread or (thread and (not STAMP.fullmatch(thread) or thread >= ts))
            or (selected.get('thread') and selected['thread'] != thread)):
        return
    # Display fields in the observed format are redacted. The userId is the recipient.
    return dict(id=observation.token(bytes.fromhex(request['key']), 'message', team, account, channel, ts),
                reply=bool(thread), messageTs=ts, conversationLabel=label,
                permalink=observation.message_permalink(None, team, channel, ts, thread))


def pinned(request, root):
    database = root / 'https_app.slack.com_0.indexeddb.leveldb'
    binding = request.get('volumeIdentity')
    epoch = dict(root=source.directory_identity(root, binding),
                 database=source.directory_identity(database, binding, 'database'))
    return source.scope_token(bytes.fromhex(request['key']), request['selection'], epoch) == request['expectedScope']


@contextmanager
def open_log(path):
    flags = os.O_RDONLY | os.O_NOFOLLOW
    directory = os.open('/', flags | os.O_DIRECTORY)
    try:
        for part in path.parts[1:-1]:
            child = os.open(part, flags | os.O_DIRECTORY, dir_fd=directory)
            os.close(directory)
            directory = child
        fd = os.open(path.name, flags | os.O_NONBLOCK, dir_fd=directory)
        try:
            yield fd
        finally:
            os.close(fd)
    finally:
        os.close(directory)


def boundary(fd, offset):
    size = min(offset, 64)
    return hashlib.sha256(os.pread(fd, size, offset - size)).digest()


def follow(request, label):
    root = Path(request['root'])
    if root.name != 'IndexedDB' or not root.is_absolute():
        return
    path = root.parent / 'logs/default/browser.log'
    thread = request['selection'].get('thread')
    if thread:
        label = label.removesuffix(f' · replies to {thread}')
    identity = None
    offset = 0
    anchor = b''
    partial = b''
    record = None
    floor = time.time_ns() // 1000
    while True:
        try:
            if any(folder.is_symlink() for folder in (root, *path.parents)) or not pinned(request, root):
                return
            with open_log(path) as fd:
                info = os.fstat(fd)
                if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid():
                    return
                current = info.st_dev, info.st_ino
                if current != identity or offset > info.st_size or (anchor and boundary(fd, offset) != anchor):
                    # Only an established tail may read a small replacement file from its beginning.
                    offset = info.st_size if identity is None else 0
                    identity, partial, record = current, b'', None
                if info.st_size - offset > 4 * LIMIT:
                    offset, partial, record = info.st_size, b'', None
                data = os.pread(fd, LIMIT, offset)
                offset += len(data)
                anchor = boundary(fd, offset)
            lines = (partial + data).split(b'\n')
            partial = lines.pop()
            if len(partial) > LIMIT:
                partial, record = b'', None
            for line in lines:
                if line.startswith(b'['):
                    record = bytearray() if HEADER.fullmatch(line) else None
                elif record is not None:
                    record.extend(line + b'\n')
                    if len(record) > LIMIT or (len(record) == len(line) + 1 and line != b'{'):
                        record = None
                    elif line == b'}':
                        try:
                            obj = json.loads(record, object_pairs_hook=source.unique_object)
                            event = project(obj, request, label, floor) if isinstance(obj, dict) else None
                        except (UnicodeError, ValueError, RecursionError):
                            event = None
                        record = None
                        if event and pinned(request, root):
                            print(json.dumps(event), flush=True)
        except OSError:
            identity, partial, record, anchor = None, b'', None, b''
        time.sleep(0.5)


if __name__ == '__main__':
    try:
        inputs = json.loads(sys.stdin.buffer.read(source.MAX_INPUT + 1))
        follow(inputs['request'], inputs['label'])
    except (ValueError, KeyError, BrokenPipeError):
        pass
