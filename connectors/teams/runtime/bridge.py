"""Account-qualified, read-only Teams snapshots and private per-selection pins."""
import sys
try:
    import resource
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    import fcntl
    import json
    import os
    from pathlib import Path
    import re
    import secrets
    import signal
    import stat
    import time

    sys.dont_write_bytecode = True
    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'validation'))
    import current_store
    import native_cache as native
    from state_directory import state_directory
except BaseException as exc:
    if sys.argv[2:] == ['--diagnostic'] and 'current_store' in globals():
        sys.stdout.write(json.dumps(current_store.structural_detail(exc)) + '\n')
    else:
        sys.stderr.write('teams_bridge_unavailable\n')
    sys.exit(1)

HEX = re.compile(r'[0-9a-f]{64}\Z')
MAX_CONFIG = 16384
MAX_ROWS = 500


def require(ok):
    if not ok:
        raise ValueError()


class ReadDeadline(BaseException):
    pass


def read_deadline(*_):
    raise ReadDeadline()


def arm_read_deadline(seconds):
    expires = time.monotonic() + seconds

    def check(*_):
        remaining = expires - time.monotonic()
        if remaining <= 0:
            read_deadline()
        signal.setitimer(signal.ITIMER_REAL, remaining)

    signal.signal(signal.SIGALRM, check)
    signal.setitimer(signal.ITIMER_REAL, seconds)


def limits():
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    caps = [(resource.RLIMIT_CPU, 30), (resource.RLIMIT_NOFILE, 128)]
    # Darwin does not support lowering address-space limits reliably. Acquisition
    # and decoding retain their byte, file, entry, node and depth budgets there.
    if sys.platform != 'darwin':
        caps.append((resource.RLIMIT_AS, 1536 * 1024 * 1024))
    for kind, cap in caps:
        soft, hard = resource.getrlimit(kind)
        ceiling = cap if hard == resource.RLIM_INFINITY else min(cap, hard)
        resource.setrlimit(kind, (ceiling, ceiling))
    arm_read_deadline(40)


def absolute(value):
    require(type(value) is str and 0 < len(value) <= 4096)
    p = Path(value)
    require(p.is_absolute() and '..' not in p.parts)
    return p


def read_config(fd, name):
    handle = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
    try:
        before = os.fstat(handle)
        require(stat.S_ISREG(before.st_mode) and before.st_uid == os.getuid()
                and stat.S_IMODE(before.st_mode) == 0o600 and before.st_nlink == 1
                and 0 < before.st_size <= MAX_CONFIG)
        raw = os.read(handle, MAX_CONFIG + 1)
        require(len(raw) == before.st_size
                and current_store.signature(before) == current_store.signature(os.fstat(handle)))
        return json.loads(raw)
    finally:
        os.close(handle)


def save_config(fd, name, config):
    temporary = '.teams-' + secrets.token_hex(16)
    handle = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                     0o600, dir_fd=fd)
    try:
        os.fchmod(handle, 0o600)
        with os.fdopen(handle, 'wb') as stream:
            stream.write(json.dumps(config, separators=(',', ':')).encode())
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, name, src_dir_fd=fd, dst_dir_fd=fd)
        os.fsync(fd)
    finally:
        try:
            os.unlink(temporary, dir_fd=fd)
        except FileNotFoundError:
            pass


def portable_path():
    path = state_directory() / 'pin-key-v1.json'
    require(not path.is_relative_to(Path(__file__).resolve().parents[1]))
    return path


def portable_directory(path, create):
    installed = Path(__file__).resolve().parents[1].stat()
    def outside_installed(fd):
        info = os.fstat(fd)
        require((info.st_dev, info.st_ino) != (installed.st_dev, installed.st_ino))
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in path.parent.parts[1:]:
            outside_installed(fd)
            if create:
                try:
                    os.mkdir(part, 0o700, dir_fd=fd)
                except FileExistsError:
                    pass
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = child
            info = os.fstat(fd)
            require(info.st_uid in (0, os.getuid()))
            require(not (info.st_mode & 0o022) or
                    (info.st_uid == 0 and info.st_mode & stat.S_ISVTX))
        outside_installed(fd)
        info = os.fstat(fd)
        require(info.st_uid == os.getuid() and stat.S_IMODE(info.st_mode) == 0o700)
        return fd
    except BaseException:
        os.close(fd)
        raise


def acquire(path):
    directory = current_store.open_directory(path)
    try:
        info = os.fstat(directory)
        require(info.st_uid == os.getuid())
        view, storage = current_store.current_view(path, expected_directory=(info.st_dev, info.st_ino))
        require(storage['stable'] and storage['checksums_verified'])
        identity = [info.st_dev, info.st_ino]
        if hasattr(info, 'st_birthtime'):
            identity.append(info.st_birthtime)
        return identity, native.stores(view)
    finally:
        os.close(directory)


def choices(cache):
    if cache is not None:
        return [absolute(cache)]
    native.check(sys.platform == 'darwin', 21)
    candidates = current_store.discover()
    native.check(candidates, 21)
    return candidates


def resolve(fd, key, reference, cache, account):
    chat, mid, replies, tenant, group_hint, parent_hint = reference
    matches = []
    present = []
    for path in choices(cache):
        physical, tables = acquire(path)
        for table, partition, records in tables:
            if table != 'replychains-2' or (tenant and tenant != partition[0]):
                continue
            if account and partition[:2] != account:
                continue
            root = parent_hint or mid
            found = {}
            if mid:
                found = native.messages(records, chat, lookup=mid)
                if mid in found:
                    root = found[mid][0] or mid
                    native.check(not parent_hint or parent_hint == root, 36)
            unresolved = replies and mid not in found
            rows = native.messages(records, chat, root_filter=root if replies else None)
            name, group, visible = native.conversation_metadata(tables, partition, chat)
            if group_hint and group:
                native.check(group == group_hint.lower(), 35)
            pin = {'cache':str(path), 'physical':physical, 'partition':partition,
                   'chat':chat, 'group':group or (group_hint and group_hint.lower()), 'root':root if replies else None}
            if (unresolved and not (rows and parent_hint in (None, mid))) or (not replies and parent_hint and mid not in found):
                pin['message'] = mid
                pin['parentHint'] = parent_hint
            name = name or ('Teams channel' if native.is_channel(chat) else 'Teams chat')
            native.snapshot_rows(key, pin, rows, name, group, False)
            verified_parent = root if mid and (mid in found or (replies and root == mid and rows)) else None
            candidate = pin, name, group, verified_parent
            matches.append(candidate)
            if mid:
                seen = mid in found or (replies and root == mid and bool(rows))
            else:
                seen = bool(rows) or visible
            if seen and (not group_hint or group):
                present.append(candidate)
    matches = present or matches
    native.check(matches, 22)
    native.check(len(matches) == 1, 23)
    pin, name, group, observed = matches[0]
    if mid:
        known = message_parent(fd, key, pin, mid, observed)
        if known:
            native.check((not parent_hint or parent_hint == known) and (not observed or observed == known), 36)
            pin.pop('message', None)
            pin.pop('parentHint', None)
            pin['root'] = known if replies else None
    return pin, name, group


def binding(fd, key, kind, scope, value=None):
    name = kind+'-'+scope+'.json'
    try:
        bound, signature = read_config(fd, name)
        native.check(signature == native.token(key, kind+'-v1', scope, bound), 24)
        return bound
    except FileNotFoundError:
        if value:
            save_config(fd, name, [value, native.token(key, kind+'-v1', scope, value)])
        return value


def message_parent(fd, key, pin, message, parent=None):
    def reference(mid):
        return native.token(key, 'reference-v1', pin['cache'], pin['physical'], pin['partition'], pin['chat'], mid)
    saved = binding(fd, key, 'message-parent', reference(message), parent)
    if parent and parent != message:
        native.check(binding(fd, key, 'message-parent', reference(parent), parent) == parent, 36)
    return saved


def group_constraint(fd, key, pin, verified_group, explicit_group):
    if not explicit_group:
        original = saved_scope(fd, key, dict(pin, group=None))
        if original:
            required = binding(fd, key, 'group', original)
            native.check(not required or not verified_group or required == verified_group, 35)
            return None
    channel = native.token(key, 'channel-v1', pin['cache'], pin['physical'], pin['partition'], pin['chat'])
    requested = pin['group']
    first = binding(fd, key, 'channel-group', channel, requested)
    if first and requested and first != requested:
        native.check(explicit_group or not verified_group, 35)
        binding(fd, key, 'multiple-groups', channel, True)
    if not requested:
        native.check(not binding(fd, key, 'multiple-groups', channel), 23)
    return verified_group or requested or first


def check_description(status):
    native.check(not status.get('groupMismatch'), 35)
    native.check(not status.get('threadMismatch'), 36)


def pinned(fd, key, scope, pin, cache, account, consent):
    native.check(not account or account == pin['partition'][:2], 24)
    native.check(cache is None or str(absolute(cache)) == pin['cache'], 24)
    try:
        physical, tables = acquire(absolute(pin['cache']))
    except FileNotFoundError:
        raise native.Refusal(24) from None
    native.check(physical == pin['physical'], 24)
    records = [records for table, binding, records in tables
               if table == 'replychains-2' and binding == pin['partition']]
    native.check(len(records) == 1, 24)
    name, group, visible_metadata = native.conversation_metadata(tables, pin['partition'], pin['chat'])
    name = name or ('Teams channel' if native.is_channel(pin['chat']) else 'Teams chat')
    subject = 'thread' if pin['root'] else 'conversation'
    bound = pin['group'] or binding(fd, key, 'group', scope, group)
    if bound and group != bound:
        status = {'groupMismatch': True} if group else {'missing': subject, 'awaitingGroup': True}
        return name, [], status
    if 'message' in pin:
        mid = pin['message']
        try:
            found = native.messages(records[0], pin['chat'], lookup=mid)
        except native.Refusal as error:
            if error.code != 36:
                raise
            return name, [], {'threadMismatch': True}
        known = message_parent(fd, key, pin, mid)
        observed = (found[mid][0] or mid) if mid in found else known
        if observed and known and observed != known:
            return name, [], {'threadMismatch': True}
        hint = pin['parentHint']
        if hint and observed and hint != observed:
            return name, [], {'threadMismatch': True}
        proposed = hint or observed or pin['root']
        root = binding(fd, key, 'thread', scope)
        if root and observed and root != observed:
            return name, [], {'threadMismatch': True}
        if not root and not observed and (not pin['root'] or (hint and hint != mid)):
            return name, [], {'missing': subject}
        root_filter = (root or proposed) if pin['root'] else None
        rows = native.messages(records[0], pin['chat'], root_filter=root_filter)
        if root is None and rows:
            if message_parent(fd, key, pin, mid, proposed) != proposed:
                return name, [], {'threadMismatch': True}
            root = binding(fd, key, 'thread', scope, proposed)
        if root is None:
            return name, [], {'missing': 'thread'}
        canonical = {k:v for k,v in pin.items() if k not in ('message','parentHint')}
        pin = dict(canonical, root=root if pin['root'] else None, group=group)
        if pin['root']:
            binding(fd, key, 'alias', native.token(key, 'pin-v1', pin), scope)
    else:
        rows = native.messages(records[0], pin['chat'], root_filter=pin['root'])
    missing = not rows and (pin['root'] is not None or not visible_metadata)
    return name, native.snapshot_rows(key,pin,rows,name,group,consent), {'missing': subject} if missing else {}



def saved_scope(fd, key, pin):
    scope = native.token(key, 'pin-v1', pin)
    try:
        saved = read_config(fd, 'pin-'+scope+'.json')
    except FileNotFoundError:
        return None
    native.check(saved == pin, 24)
    return scope


def selection_handle(fd, key, pin, reference, cache, account):
    _, mid, replies, _, _, hint = reference
    if replies and 'message' in pin:
        old = {k:v for k,v in pin.items() if k not in ('message','parentHint')}
        old['root'] = mid
        if saved_scope(fd, key, old):
            native.check(not hint or hint == mid, 36)
            pin = old

    if mid and (replies or hint) and 'message' not in pin:
        early = dict(pin, root=(hint or mid) if replies else None, message=mid, parentHint=hint)
        for candidate in (early, dict(early, group=None)) if pin['group'] else (early,):
            scope = saved_scope(fd, key, candidate)
            if not scope:
                continue
            if not candidate['group'] and pin['group'] and binding(fd, key, 'group', scope, pin['group']) != pin['group']:
                continue
            _, _, status = pinned(fd, key, scope, candidate, cache, account, False)
            check_description(status)
            return scope, candidate

    exact = saved_scope(fd, key, pin)
    if exact:
        return exact, pin
    scope = native.token(key, 'pin-v1', pin)
    if pin['group']:
        early = dict(pin, group=None)
        previous = saved_scope(fd, key, early)
        if previous and binding(fd, key, 'group', previous, pin['group']) == pin['group']:
            return previous, early
    if pin['root'] and 'message' not in pin:
        alias = binding(fd, key, 'alias', scope)
        if alias:
            saved = read_config(fd, 'pin-'+alias+'.json')
            native.check(native.token(key, 'pin-v1', saved) == alias, 24)
            _, _, status = pinned(fd, key, alias, saved, cache, account, False)
            check_description(status)
            return alias, saved
    save_config(fd, 'pin-'+scope+'.json', pin)
    return scope, pin


def run(command):
    native.check(command in ('resolve','configured-snapshot'), 20)
    raw = sys.stdin.buffer.read(MAX_CONFIG+1)
    native.check(len(raw) <= MAX_CONFIG, 20)
    try:
        request = json.loads(raw)
    except (ValueError,UnicodeError):
        raise native.Refusal(20) from None
    native.check(type(request) is dict, 20)
    cache = request.get('cachePath')
    if 'cachePath' in request:
        try:
            absolute(cache)
        except ValueError:
            raise native.Refusal(20) from None
    account = request.get('account')
    if 'account' in request:
        native.check(type(account) is str and re.fullmatch(f'{native.GUID}/{native.GUID}', account), 20)
        account = account.lower().split('/')
    reference = None
    consent = False
    if command == 'resolve':
        native.check(set(request) <= {'selection','scope','cachePath','account'},20)
        value = request.get('selection')
        if type(value) is str and value.startswith('scope-') and HEX.fullmatch(value[6:]):
            scope = value[6:]
            native.check('scope' not in request, 20)
        else:
            reference = native.reference(value, request.get('scope'))
    else:
        native.check(set(request) <= {'scope','cachePath','includeMessagePreview','account'},20)
        scope, consent = request.get('scope'), request.get('includeMessagePreview')
        native.check(type(scope) is str and HEX.fullmatch(scope) and type(consent) is bool,20)
    state = portable_path()
    try:
        fd = portable_directory(state, create=reference is not None)
    except FileNotFoundError:
        raise native.Refusal(24) from None
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        try:
            encoded = read_config(fd,state.name)
            require(type(encoded) is str and HEX.fullmatch(encoded))
            key = bytes.fromhex(encoded)
        except FileNotFoundError:
            native.check(reference is not None, 24)
            key = secrets.token_bytes(32)
            save_config(fd,state.name,key.hex())
        if reference:
            pin, name, verified_group = resolve(fd, key, reference, cache, account)
            pin['group'] = group_constraint(fd, key, pin, verified_group, reference[4])
            scope, pin = selection_handle(fd, key, pin, reference, cache, account)
        else:
            try:
                pin = read_config(fd,'pin-'+scope+'.json')
            except FileNotFoundError:
                raise native.Refusal(24) from None
            native.check(native.token(key,'pin-v1',pin) == scope,24)
            name, rows, status = pinned(fd,key,scope,pin,cache,account,consent)
            if command == 'resolve':
                check_description(status)
        if command == 'resolve':
            if 'message' in pin and pin['root']:
                name = f"Thread for message {pin['message']} in {name}"
            elif pin['root']:
                name = f"Replies in {name} (root {pin['root']})"
            return {'scope':scope,'label':name}
        return {'scope':scope,'includeMessagePreview':consent,'messages':rows,
                **status}
    finally:
        os.close(fd)


def main():
    diagnostics = sys.argv[2:] == ['--diagnostic']
    try:
        limits()
        native.check(len(sys.argv) == 2 or diagnostics, 20)
        result = run(sys.argv[1])
        sys.stdout.write(json.dumps(result,separators=(',',':'))+'\n')
        return 0
    except BaseException as exc:
        if isinstance(exc, native.Refusal):
            code = exc.code
        elif isinstance(exc, ReadDeadline):
            code = 34
        elif isinstance(exc, current_store.ReadFailure):
            code = {'manifest': 30, 'tables': 31, 'wal': 32, 'stability': 33}[exc.stage]
        else:
            code = 21
        if diagnostics:
            detail = getattr(exc, 'detail', None) or current_store.structural_detail(exc)
            sys.stdout.write(json.dumps(detail, separators=(',', ':')) + '\n')
        return code


if __name__ == '__main__':
    sys.exit(main())
