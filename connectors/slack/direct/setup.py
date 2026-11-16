"""Configure-only discovery of an explicitly authorized persisted-cache selection."""
import contextlib
import fcntl
import json
import logging
import os
from pathlib import Path
import secrets
import stat
import sys
import tempfile

import observation
import source


def require(value):
    if not value:
        raise ValueError('setup')


def locations(custom):
    if custom:
        path = Path(custom)
        require(path.is_absolute())
        return {'custom': path}
    require(sys.platform == 'darwin')
    home = Path.home()
    return {
        'standard': home / 'Library/Application Support/Slack/IndexedDB',
        'sandbox': home / 'Library/Containers/com.tinyspeck.slackmacgap/Data/Library/Application Support/Slack/IndexedDB',
    }


def safe_path(path):
    require(path.is_absolute())
    for parent in (path, *path.parents):
        require(not parent.is_symlink())
    return path.resolve()


def private_file(path, flags):
    fd = os.open(path, flags | os.O_NOFOLLOW, 0o600)
    info = os.fstat(fd)
    if not (stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid()
            and info.st_nlink == 1 and info.st_mode & 0o077 == 0):
        os.close(fd)
        raise ValueError('private file')
    return fd


def setup(values):
    require(isinstance(values, dict) and not set(values) - {'sourceMode', 'conversationSnippet', 'cacheRoot', 'selectionRevision'})
    require(values.get('sourceMode') == 'persisted-cache')
    snippet = values.get('conversationSnippet')
    custom = values.get('cacheRoot', '')
    revision = values.get('selectionRevision', '') or '1'
    require(isinstance(snippet, str) and 1 <= len(snippet.encode()) <= 16384)
    require(isinstance(custom, str) and len(custom) <= 4096)
    require(isinstance(revision, str) and 1 <= len(revision) <= 128)
    roots = locations(custom)
    data = os.environ.get('EXANGELOS_HOME')
    base = Path(data) if data else Path(os.environ.get('XDG_DATA_HOME') or Path.home() / '.local/share') / 'exangelos'
    directory = safe_path(base / 'connectors/slack')
    require(not directory.is_relative_to(Path(__file__).resolve().parent.parent))
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    info = directory.stat()
    require(info.st_uid == os.getuid() and info.st_mode & 0o077 == 0)
    with os.fdopen(private_file(directory / 'setup.lock', os.O_RDWR | os.O_CREAT), 'r+') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return configured(directory, roots, snippet, custom, revision)


def configured(directory, roots, snippet, custom, revision):
    path = directory / 'setup.json'
    previous = None
    try:
        fd = private_file(path, os.O_RDONLY)
    except FileNotFoundError:
        pass
    else:
        with os.fdopen(fd, 'r') as handle:
            raw = handle.read(source.MAX_INPUT + 1)
        require(len(raw) <= source.MAX_INPUT)
        previous = json.loads(raw, object_pairs_hook=source.unique_object)
        require(previous['version'] == 1)
        key = bytes.fromhex(previous['request']['key'])
        selector = observation.token(key, 'setup-selector-v1', snippet, custom, revision)
        if secrets.compare_digest(previous['selector'], selector):
            root = safe_path(roots[previous['location']])
            require(source.inventory(root)[1] == previous['epoch'])
            request = pinned_request(previous['request']['selection'], key, root, previous['epoch'])
            validate(request)
            return request
        # Selection changes are deliberate: editing a snippet alone must not silently repin an account.
        require(previous['revision'] != revision)
    key = secrets.token_bytes(32)
    matches = []
    inventories = {}
    for location, path_root in roots.items():
        root = safe_path(path_root)
        try:
            root.stat()
        except FileNotFoundError:
            inventories[root] = None
            continue
        before, epoch = source.inventory(root)
        inventories[root] = (before, epoch)
        candidates = set()

        def collect(state, generation):
            identity = observation.scope(state)
            for conversation, messages in (state.get('messages') or {}).items():
                for message in messages.values():
                    text = message.get('text') if isinstance(message, dict) else None
                    if isinstance(text, str) and snippet in text:
                        candidates.add((*identity, conversation))

        result = source.scan.run(root, observe=collect)
        require(not result['external_rejections'] and not result['files_changed'] and result['current_unchanged'])
        require(source.inventory(root) == (before, epoch))
        for workspace, owner, conversation in candidates:
            matches.append((location, root, epoch, {'workspace': workspace, 'owner': owner, 'conversations': [conversation]}))
    require(len(matches) == 1)
    location, root, epoch, selection = matches[0]
    request = pinned_request(selection, key, root, epoch)
    validate(request)
    for inspected, expected in inventories.items():
        if expected is None:
            require(not inspected.exists())
        else:
            require(source.inventory(inspected) == expected)
    saved = {'version': 1, 'request': request, 'location': location, 'epoch': epoch, 'revision': revision,
             'selector': observation.token(key, 'setup-selector-v1', snippet, custom, revision)}
    fd, temporary = tempfile.mkstemp(prefix='.setup-', dir=directory)
    try:
        with os.fdopen(fd, 'w') as handle:
            json.dump(saved, handle, separators=(',', ':'))
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, directory / 'setup.json')
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    return request


def pinned_request(selection, key, root, epoch):
    expected = observation.token(key, 'selected-scope-v1', selection['workspace'], selection['owner'],
                                 sorted(selection['conversations']), epoch)
    return {'selection': selection, 'key': key.hex(), 'root': str(root), 'expectedScope': expected}


def validate(request):
    snapshot = source.acquire(request)
    require(len(snapshot['messages']) <= 500)
    require(all(len(message['reactions']) <= 100 for message in snapshot['messages']))


def main():
    logging.disable(logging.CRITICAL)
    try:
        with open(os.devnull, 'w') as sink, contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink):
            raw = sys.stdin.buffer.read(source.MAX_INPUT + 1)
            require(len(raw) <= source.MAX_INPUT)
            result = setup(json.loads(raw, object_pairs_hook=source.unique_object))
            output = json.dumps(result, separators=(',', ':'))
    except BaseException:
        sys.stderr.write('Slack persisted setup unavailable.\n')
        return 1
    sys.stdout.write(output + '\n')
    return 0


if __name__ == '__main__':
    sys.exit(main())
