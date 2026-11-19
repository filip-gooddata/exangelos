"""Configure-only discovery of an explicitly authorized persisted-cache selection."""
import contextlib
import fcntl
import json
import logging
import os
from pathlib import Path
import re
import secrets
import stat
import sys
import tempfile

import observation
import source


def require(value):
    if not value:
        raise ValueError('setup')


class SetupRejected(ValueError):
    """Only fixed process exit codes cross the private worker boundary."""


def conversation_target(value):
    conversation = r'([CDG][A-Z0-9]{6,30})'
    match = re.fullmatch(conversation, value)
    if match:
        return None, match[1]
    match = re.fullmatch(r'https://app\.slack\.com/client/(T[A-Z0-9]{6,30})/' + conversation + r'/?', value)
    if match:
        return match[1], match[2]
    match = re.fullmatch(r'https://[a-z0-9-]+\.slack\.com/archives/' + conversation + r'(?:/p[0-9]+)?/?', value)
    if match:
        return None, match[1]
    raise SetupRejected(20)


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
    require(isinstance(values, dict) and not set(values) - {'sourceMode', 'conversationSnippet', 'cacheRoot', 'selectionRevision', 'conversationId'})
    require(values.get('sourceMode') in ('persisted-cache', 'pinned-cache'))
    snippet = values.get('conversationSnippet', '')
    direct = values.get('conversationId', '')
    custom = values.get('cacheRoot', '')
    revision = values.get('selectionRevision', '') or '1'
    require(isinstance(snippet, str) and len(snippet.encode()) <= 16384)
    require(isinstance(custom, str) and len(custom) <= 4096)
    require(isinstance(revision, str) and 1 <= len(revision) <= 128)
    if not isinstance(direct, str) or len(direct) > 4096 or (snippet and direct):
        raise SetupRejected(20)
    if values['sourceMode'] == 'pinned-cache' and (snippet or direct):
        raise SetupRejected(26)
    target = conversation_target(direct) if direct else None
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
        return configured(directory, roots, snippet, custom, revision, target)


def configured(directory, roots, snippet, custom, revision, target):
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
        require(previous['version'] == 1 and re.fullmatch(r'[0-9a-f]{64}', previous['selector']))
        key = bytes.fromhex(previous['request']['key'])
        selector = selector_digest(key, snippet, target, custom, revision)
        resume = not snippet and not target
        if resume and (previous['revision'] != revision or previous['location'] not in roots):
            raise SetupRejected(24)
        if resume or secrets.compare_digest(previous['selector'], selector):
            root = safe_path(roots[previous['location']])
            if resume and custom and str(root) != previous['request']['root']:
                raise SetupRejected(24)
            if source.inventory(root)[1] != previous['epoch']:
                raise SetupRejected(24)
            request = pinned_request(previous['request']['selection'], key, root, previous['epoch'])
            require(request['expectedScope'] == previous['request']['expectedScope'])
            validate(request)
            return request
        # Selection changes are deliberate: editing a snippet alone must not silently repin an account.
        if previous['revision'] == revision:
            raise SetupRejected(24)
    if not snippet and not target:
        raise SetupRejected(20)
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

        observed = False

        def collect(state, generation):
            nonlocal observed
            observed = True
            identity = observation.scope(state)
            if target:
                workspace, conversation = target
                if workspace is None or workspace == identity[0]:
                    if any(conversation in (state.get(field) or {}) for field in ('messages', 'channels')):
                        candidates.add((*identity, conversation))
                return
            for conversation, messages in (state.get('messages') or {}).items():
                for message in messages.values():
                    text = message.get('text') if isinstance(message, dict) else None
                    if isinstance(text, str) and snippet in text:
                        candidates.add((*identity, conversation))

        result = source.scan.run(root, observe=collect)
        require(not result['external_rejections'] and not result['files_changed'] and result['current_unchanged'])
        require(observed and source.inventory(root) == (before, epoch))
        for workspace, owner, conversation in candidates:
            matches.append((location, root, epoch, {'workspace': workspace, 'owner': owner, 'conversations': [conversation]}))
    if not any(value is not None for value in inventories.values()):
        raise SetupRejected(21)
    if not matches:
        raise SetupRejected(22)
    if len(matches) > 1:
        raise SetupRejected(23)
    location, root, epoch, selection = matches[0]
    request = pinned_request(selection, key, root, epoch)
    validate(request)
    for inspected, expected in inventories.items():
        if expected is None:
            require(not inspected.exists())
        else:
            require(source.inventory(inspected) == expected)
    saved = {'version': 1, 'request': request, 'location': location, 'epoch': epoch, 'revision': revision,
             'selector': selector_digest(key, snippet, target, custom, revision)}
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


def selector_digest(key, snippet, target, custom, revision):
    if target:
        return observation.token(key, 'setup-conversation-v1', target, custom, revision)
    return observation.token(key, 'setup-selector-v1', snippet, custom, revision)


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
    except SetupRejected as error:
        return error.args[0]
    except (FileNotFoundError, PermissionError):
        return 21
    except BlockingIOError:
        return 25
    except BaseException:
        sys.stderr.write('Slack persisted setup unavailable.\n')
        return 1
    sys.stdout.write(output + '\n')
    return 0


if __name__ == '__main__':
    sys.exit(main())
