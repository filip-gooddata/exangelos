"""Discovery and pin resolution after explicit persisted-cache consent."""
from __future__ import annotations
from dataclasses import dataclass
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
import time

import observation
import source
from state_directory import state_directory


def require(value):
    if not value:
        raise ValueError('setup')


class SetupRejected(ValueError):
    """Only fixed process exit codes cross the private worker boundary."""


CHANNEL = r'[CDG][A-Z0-9]{6,30}'
WORKSPACE = r'T[A-Z0-9]{6,30}'
TS = observation.TIMESTAMP


@dataclass(frozen=True)
class Target:
    channel: str | None = None
    timestamp: str | None = None
    workspace: str | None = None
    parent: str | None = None
    domain: str | None = None


def parse_subject(subject):
    if re.fullmatch(CHANNEL, subject):
        return Target(channel=subject)
    match = re.fullmatch(rf'(?:(?P<channel>{CHANNEL}):)?(?P<ts>{TS})', subject)
    if match:
        return Target(match['channel'], match['ts'])
    match = re.fullmatch(rf'https://app\.slack\.com/client/({WORKSPACE})/({CHANNEL})/?', subject)
    if match:
        return Target(channel=match[2], workspace=match[1])
    path, separator, query = subject.partition('?')
    match = re.fullmatch(rf'https://[a-z0-9](?:[a-z0-9-]{{0,61}}[a-z0-9])?\.slack\.com/archives/({CHANNEL})(?:/p([0-9]{{7,26}}))?/?', path)
    if not match:
        raise SetupRejected(20)
    channel, digits = match.groups()
    timestamp = digits[:-6] + '.' + digits[-6:] if digits else None
    hints = {}
    if separator:
        for field in query.split('&'):
            key, _, value = field.partition('=')
            if key in hints or key not in ('cid', 'thread_ts') or not timestamp:
                raise SetupRejected(20)
            if (key == 'cid' and value != channel) or (key == 'thread_ts' and not re.fullmatch(TS, value)):
                raise SetupRejected(20)
            hints[key] = value
    return Target(channel, timestamp, parent=hints.get('thread_ts'), domain=path.split('/')[2].split('.')[0])


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


def private_directory():
    directory = safe_path(state_directory())
    require(not directory.is_relative_to(Path(__file__).resolve().parent.parent))
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    info = directory.stat()
    require(info.st_uid == os.getuid() and info.st_mode & 0o077 == 0)
    return directory


@contextlib.contextmanager
def locked(directory):
    with os.fdopen(private_file(directory / 'setup.lock', os.O_RDWR | os.O_CREAT), 'r+') as lock:
        deadline = time.monotonic() + 1.0
        while True:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise
                time.sleep(0.02)
        yield


def candidates(state, target):
    workspace, owner = observation.scope(state)
    if target.workspace and target.workspace != workspace:
        return
    domain = observation.workspace_domain(state, workspace) if target.domain else None
    if domain is not None and target.domain != domain:
        return
    verified = not target.domain or domain is not None
    messages = state.get('messages') or {}
    channels = state.get('channels') or {}
    for channel in ([target.channel] if target.channel else messages):
        if channel not in messages and channel not in channels:
            continue
        if target.timestamp is None:
            yield workspace, owner, channel, None, verified, observation.conversation_label(state, workspace, channel, include_members=True)
            continue
        rows = messages.get(channel, {})
        require(isinstance(rows, dict))
        if target.timestamp not in rows:
            continue
        message = rows[target.timestamp]
        require(isinstance(message, dict) and message.get('ts') == target.timestamp)
        require(not message.get('_hidden_stub') and not message.get('no_display'))
        require(all(message.get(field) in (None, channel) for field in ('channel', 'channel_id')))
        require(message.get('team', workspace) == workspace)
        parent = message.get('thread_ts')
        require(parent is None or isinstance(parent, str) and re.fullmatch(TS, parent))
        parent = parent or target.timestamp
        if target.parent is None or parent == target.parent:
            yield workspace, owner, channel, parent, verified, observation.conversation_label(state, workspace, channel, include_members=True)


def subscription_identity(secret, epoch, selection):
    key = observation.token(secret, 'subscription-key-v2', epoch['root'], selection['workspace'],
                            selection['owner'], selection['conversations'][0], selection.get('thread'))
    return key, source.scope_token(bytes.fromhex(key), selection, epoch)


def discover(roots, secret, target, scope):
    matches = []
    inventories = {}
    for path in roots.values():
        root = safe_path(path)
        try:
            root.stat()
        except FileNotFoundError:
            inventories[root] = None
            continue
        binding = {'kind': 'volume'} if sys.platform == 'darwin' else None
        try:
            before, epoch = source.inventory(root, binding)
        except source.VolumeIdentityUnavailable:
            binding = None
            before, epoch = source.inventory(root)
        inventories[root] = (before, epoch), binding
        observed = False

        def collect(state, generation):
            nonlocal observed
            observed = True
            for candidate in candidates(state, target):
                matches.append((root, epoch, binding, *candidate))

        result = source.scan.run(root, observe=collect)
        require(observed and not result['external_rejections'] and not result['files_changed'] and result['current_unchanged'])
    if not any(value is not None for value in inventories.values()):
        raise SetupRejected(21)
    if not any(match[-2] for match in matches):
        raise SetupRejected(22)
    if len(matches) != 1:
        raise SetupRejected(23)
    root, epoch, binding, workspace, owner, channel, parent, _, label = matches[0]
    selection = dict(workspace=workspace, owner=owner, conversations=[channel])
    if parent:
        if scope is None and parent == target.timestamp:
            raise SetupRejected(27)
        if scope != 'conversation':
            selection['thread'] = parent
    key, handle = subscription_identity(secret, epoch, selection)
    request = dict(selection=selection, key=key, root=str(root), expectedScope=handle)
    if binding:
        request['volumeIdentity'] = binding
    validate(request)
    for inspected, expected in inventories.items():
        if expected is None:
            require(not inspected.exists())
        else:
            previous, mode = expected
            require(source.inventory(inspected, mode) == previous)
    return epoch, request, label


def save_json(path, saved):
    fd, temporary = tempfile.mkstemp(prefix='.setup-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as handle:
            json.dump(saved, handle, separators=(',', ':'))
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def read_json(path):
    with os.fdopen(private_file(path, os.O_RDONLY)) as stream:
        raw = stream.read(source.MAX_INPUT + 1)
    require(len(raw) <= source.MAX_INPUT)
    return json.loads(raw, object_pairs_hook=source.unique_object)


def reopen(directory, roots, handle, *, pin_only=False):
    path = directory / ('scope-' + handle + '.json')
    try:
        saved = read_json(path)
    except FileNotFoundError:
        raise SetupRejected(24) from None
    if saved.get('version') != 2:
        raise SetupRejected(24)
    epoch = saved.get('epoch')
    if not isinstance(epoch, dict) or saved['request']['expectedScope'] != handle:
        raise SetupRejected(24)
    binding = saved['request'].get('volumeIdentity')
    for configured_root in roots.values():
        root = safe_path(configured_root)
        try:
            identity = source.directory_identity(root, binding)
        except (FileNotFoundError, source.PinnedScopeChanged):
            continue
        if identity == epoch.get('root'):
            break
    else:
        raise SetupRejected(24)
    try:
        if source.directory_epoch(root, binding) != epoch:
            raise SetupRejected(24)
    except source.PinnedScopeChanged:
        raise SetupRejected(24) from None
    request = dict(saved['request'], root=str(root))
    label = saved['label']
    def verify():
        require(source.scope_token(bytes.fromhex(request['key']), request['selection'],
                                   source.directory_epoch(root, request.get('volumeIdentity'))) == handle)
        if not pin_only:
            validate(request)

    verify()
    if binding is None and sys.platform == 'darwin':
        # Add proof only while both original directory identities still match.
        # The historical device numbers remain inputs to the scope token.
        paths = dict(root=root, database=root / 'https_app.slack.com_0.indexeddb.leveldb')
        try:
            aliases = {
                part: [source.directory_identity(folder, {'kind': 'volume'}, verified_legacy=epoch[part])[0], epoch[part][0]]
                for part, folder in paths.items()
            }
        except source.VolumeIdentityUnavailable:
            aliases = None
        except source.PinnedScopeChanged:
            raise SetupRejected(24) from None
        if aliases:
            request['volumeIdentity'] = dict(kind='legacy', **aliases)
            verify()
            # The volume-keyed alias keeps equivalent raw references on this subject.
            portable = {part: [pair[0], *epoch[part][1:]] for part, pair in aliases.items()}
            try:
                secret = bytes.fromhex(read_json(directory / 'subscriptions-key.json'))
            except FileNotFoundError:
                secret = None
            if secret is not None:
                _, canonical = subscription_identity(secret, portable, request['selection'])
                save_json(directory / ('alias-' + canonical + '.json'), handle)
            save_json(path, dict(saved, request=request))
    return request, label


def equivalent_pin(directory, root, secret, request):
    try:
        handle = read_json(directory / ('alias-' + request['expectedScope'] + '.json'))
        require(isinstance(handle, str) and re.fullmatch('[a-f0-9]{64}', handle))
    except FileNotFoundError:
        # Before the first verified reopen, the pre-upgrade scope is still
        # derivable from the device numbers at the selected location.
        legacy_epoch = {
            'root': source.directory_identity(root),
            'database': source.directory_identity(root / 'https_app.slack.com_0.indexeddb.leveldb')
        }
        _, handle = subscription_identity(secret, legacy_epoch, request['selection'])
        if not (directory / ('scope-' + handle + '.json')).exists():
            return None
    try:
        existing, _ = reopen(directory, {'selected': root}, handle)
    except SetupRejected as error:
        if error.args == (24,):
            return None
        raise
    require(existing['selection'] == request['selection'])
    return existing


def setup(values):
    if not isinstance(values, dict) or values.get('subscriptionAccess') != 'persisted-cache':
        raise SetupRejected(26)
    subject = values.get('subject')
    scope = values.get('scope')
    custom = values.get('cacheRoot', '')
    if (set(values) - {'subscriptionAccess', 'cacheRoot', 'subject', 'scope', 'pinOnly'}
            or not isinstance(subject, str) or not 1 <= len(subject) <= 4096
            or ('scope' in values and scope not in ('conversation', 'replies'))
            or not isinstance(custom, str) or len(custom) > 4096):
        raise SetupRejected(20)
    handle = re.fullmatch(r'scope-([a-f0-9]{64})', subject)
    target = None if handle else parse_subject(subject)
    if 'pinOnly' in values and (values['pinOnly'] != 'true' or not handle):
        raise SetupRejected(20)
    if (handle and scope) or (target and not target.timestamp and scope == 'replies'):
        raise SetupRejected(20)
    roots = locations(custom)
    directory = private_directory()
    if handle:
        request, label = reopen(directory, roots, handle[1], pin_only='pinOnly' in values)
    else:
        with locked(directory):
            try:
                fd = private_file(directory / 'subscriptions-key.json', os.O_RDONLY)
            except FileNotFoundError:
                secret = secrets.token_hex(32)
                save_json(directory / 'subscriptions-key.json', secret)
            else:
                with os.fdopen(fd) as stream:
                    secret = json.loads(stream.read(128))
            require(isinstance(secret, str) and re.fullmatch(r'[a-f0-9]{64}', secret))
        epoch, request, label = discover(roots, bytes.fromhex(secret), target, scope)
        existing = None
        if request.get('volumeIdentity') == {'kind': 'volume'}:
            existing = equivalent_pin(directory, Path(request['root']), bytes.fromhex(secret), request)
        if existing is None:
            path = directory / ('scope-' + request['expectedScope'] + '.json')
            save_json(path, dict(version=2, epoch=epoch, request=request, label=label))
        else:
            request = existing
    selection = request['selection']
    require(isinstance(label, str) and len(label) <= 128 and label.isprintable())
    if 'thread' in selection:
        label = f"{label} · replies to {selection['thread']}"
    return dict(request, label=label)


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
            values = json.loads(raw, object_pairs_hook=source.unique_object)
            result = setup(values)
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
