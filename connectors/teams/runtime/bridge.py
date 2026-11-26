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

    sys.dont_write_bytecode = True
    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'validation'))
    import native_cache as native
    import current_store
    from state_directory import state_directory
except BaseException:
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
    signal.signal(signal.SIGALRM, read_deadline)
    signal.alarm(40)


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


def resolve(key, reference, cache, account):
    chat, mid, replies, tenant, group_hint, parent_hint = reference
    matches = []
    for path in choices(cache):
        physical, tables = acquire(path)
        for table, partition, records in tables:
            if table != 'replychains-2' or (tenant and tenant != partition[0]):
                continue
            if account and partition[:2] != account:
                continue
            if replies and not parent_hint:
                found = native.messages(records, chat, lookup=mid)
                if mid not in found:
                    continue
                root_filter = found[mid][0] or mid
            else:
                root_filter = parent_hint if replies else None
            rows = native.messages(records, chat, root_filter=root_filter)
            if not rows or (mid and mid not in rows):
                continue
            name, group = native.conversation_metadata(tables, partition, chat)
            if group_hint:
                native.check(group and group == group_hint.lower(), 23)
            root = (rows[mid][0] or mid) if mid else None
            native.check(not parent_hint or parent_hint == root, 20)
            if replies:
                native.check(root in rows and rows[root][0] is None, 28)
            pin = {'cache':str(path), 'physical':physical, 'partition':partition,
                   'chat':chat, 'group':group, 'root':root if replies else None}
            name = name or ('Teams channel' if native.is_channel(chat) else 'Teams chat')
            native.snapshot_rows(key, pin, rows, name, group, False)
            matches.append((pin,name))
    native.check(matches, 22)
    native.check(len(matches) == 1, 23)
    return matches[0]


def pinned(key, pin, cache, account, consent):
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
    rows = native.messages(records[0], pin['chat'], root_filter=pin['root'])
    native.check(rows and (not pin['root'] or
                 (pin['root'] in rows and rows[pin['root']][0] is None)), 24)
    name, group = native.conversation_metadata(tables, pin['partition'], pin['chat'])
    native.check(group == pin['group'], 24)
    name = name or ('Teams channel' if native.is_channel(pin['chat']) else 'Teams chat')
    return name, native.snapshot_rows(key,pin,rows,name,group,consent)


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
            pin, name = resolve(key, reference, cache, account)
            scope = native.token(key, 'pin-v1', pin)
            save_config(fd,'pin-'+scope+'.json',pin)
        else:
            try:
                pin = read_config(fd,'pin-'+scope+'.json')
            except FileNotFoundError:
                raise native.Refusal(24) from None
            native.check(native.token(key,'pin-v1',pin) == scope,24)
            name, rows = pinned(key,pin,cache,account,consent)
        if command == 'resolve':
            if pin['root']:
                name = f"Replies in {name} (root {pin['root']})"
            return {'scope':scope,'label':name}
        return {'scope':scope,'includeMessagePreview':consent,'messages':rows}
    finally:
        os.close(fd)


def main():
    try:
        limits()
        native.check(len(sys.argv) == 2, 20)
        result = run(sys.argv[1])
        sys.stdout.write(json.dumps(result,separators=(',',':'))+'\n')
        return 0
    except native.Refusal as exc:
        return exc.code
    except ReadDeadline:
        return 34
    except current_store.ReadFailure as exc:
        return {'manifest': 30, 'tables': 31, 'wal': 32, 'stability': 33}[exc.stage]
    except BaseException:
        return 21


if __name__ == '__main__':
    sys.exit(main())
