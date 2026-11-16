"""Private native-cache bridge. Null memberships mean unknown, not removal.

Portable commands: `configure` accepts bounded stdin JSON with selectionToken
and optional absolute cachePath; `configured-snapshot` reuses generated external
selection state. Only configure discovers native macOS candidates. Neither new
command reads legacy EXANGELOS_TEAMS_CONFIG/CACHE. Cache selection is not proof
of signed-in account identity.

SDK: `configure` reads bounded JSON from stdin, discovers only during that call,
and creates external private selection state. `configured-snapshot` reads that
state. Neither command uses the legacy Teams config/cache environment variables.
Legacy diagnostics: `setup` prompts privately and `snapshot` reads the explicit
EXANGELOS_TEAMS_CONFIG file. Success is one JSON line (setup is silent), exit 0.
Failure is empty stdout, exit 1, and fixed stderr teams_bridge_unavailable.
Unsupported/invalid records anywhere in the selected database fail the snapshot.
Missing/unsupported reaction representations alone are unknown (null). Native
quote linkage and reaction memberships are bounded to the live-validated shapes.
"""
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
    import action_probe as action
    import current_store
    import reactions
except BaseException:
    sys.stderr.write('teams_bridge_unavailable\n')
    sys.exit(1)

HEX = re.compile(r'[0-9a-f]{64}\Z')
MAX_CONFIG = 16384
MAX_ROWS = 500


def require(ok):
    if not ok:
        raise ValueError()


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
    signal.signal(signal.SIGALRM, lambda *_: (_ for _ in ()).throw(ValueError()))
    signal.alarm(40)


def absolute(value):
    require(type(value) is str and 0 < len(value) <= 4096)
    p = Path(value)
    require(p.is_absolute() and '..' not in p.parts)
    return p


def config_directory(path):
    fd = current_store.open_directory(path.parent)
    try:
        info = os.fstat(fd)
        require(info.st_uid == os.getuid() and stat.S_IMODE(info.st_mode) == 0o700)
        return fd
    except BaseException:
        os.close(fd)
        raise


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
        value = json.loads(raw)
        require(type(value) is dict and set(value) == {'key', 'cache', 'scope'})
        require(type(value['key']) is str and HEX.fullmatch(value['key']))
        require(type(value['scope']) is str and HEX.fullmatch(value['scope']))
        absolute(value['cache'])
        return value
    finally:
        os.close(handle)


def acquire(cache):
    path = absolute(cache)
    fd = current_store.open_directory(path)
    try:
        require(os.fstat(fd).st_uid == os.getuid())
    finally:
        os.close(fd)
    view, storage = current_store.current_view(path)
    require(storage['stable'] and storage['checksums_verified'])
    return view


def audit_bodies(view, origin, key, selected):
    memberships = {}
    # extract intentionally skips missing body candidates; polling must fail closed.
    for raw_key, raw in view.items():
        db, store, index, _ = action.prefix(raw_key)
        if not (db and store and index == 1):
            continue
        walk = dict.fromkeys(action.sem.COUNTERS, 0)
        for node, _, _, _ in action.sem._walk(action.s._decode(raw), walk):
            if not action.candidate_shape(node, require_body=False):
                continue
            fields = action.candidate_fields(node)
            scopes = {v for f, v in fields.items() if f in action.sem.FIELDS['scope'] - {'teamid'}
                      and type(v) is str and v}
            if not any(action.fingerprint(key, 'scope', [origin, db, scope]) == selected for scope in scopes):
                continue
            if not any(type(fields.get(f)) in (str, int) for f in action.sem.FIELDS['identity']):
                continue
            if not any(f in action.sem.FIELDS['created'] and action.s._timestamp(v) for f, v in fields.items()):
                continue
            require(len(scopes) == 1)
            bodies = [v for f, v in fields.items() if f in ('body', 'content')]
            require(bodies and all(type(v) is str for v in bodies))
            require(all(v is None or type(v) in (str, int) for f, v in fields.items()
                        if f in ('replytoid', 'parentmessageid', 'replytomessageid')))
            identity = next(fields[f] for f in ('messageid', 'id', 'clientmessageid')
                            if type(fields.get(f)) in (str, int))
            marker = action.fingerprint(key, 'identity', identity).hex()
            values = reactions.members(node)
            members = None if values is None else sorted(
                action.fingerprint(key, 'reaction-member', list(value)).hex() for value in values)
            require(marker not in memberships or memberships[marker] == members)
            memberships[marker] = members
        require(not walk['walk_limited'])
    return memberships


def envelope(view, cache, key, selected):
    databases = {}
    for raw, value in view.items():
        db, store, index, _ = action.prefix(raw)
        if db and store and index == 1:
            databases.setdefault(db, {})[raw] = value
    matches = []
    for records in databases.values():
        part = action.extract(records, cache, key, selected=selected)
        if part.rows:
            matches.append((records, part))
    require(len(matches) == 1)
    records, _ = matches[0]
    part = action.extract(records, cache, key)
    require(not any(part.stats.values()))
    part.rows = {marker: row for marker, row in part.rows.items() if marker[0] == selected}
    require(0 < len(part.rows) <= MAX_ROWS)
    memberships = audit_bodies(records, cache, key, selected)
    rows = []
    for (scope, identity), row in part.rows.items():
        require(scope == selected and row is not None)
        body, reaction, _, parents = row[0]
        require(body[0] in (2, 3) and body[1] is not None and len(parents) <= 1)
        rows.append({'id': identity.hex(), 'body': body[1].hex(),
                     'reactions': memberships[identity.hex()],
                     'parent': next(iter(parents)).hex() if parents else None,
                     'reaction': reaction[1].hex() if reaction[0] in (2, 3) and reaction[1] else None})
    return {'scope': selected.hex(), 'messages': sorted(rows, key=lambda r: r['id'])}


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
    if 'EXANGELOS_HOME' in os.environ:
        root = absolute(os.environ['EXANGELOS_HOME'])
    elif 'XDG_DATA_HOME' in os.environ:
        root = absolute(os.environ['XDG_DATA_HOME']) / 'exangelos'
    else:
        root = absolute(os.environ.get('HOME')) / '.local/share/exangelos'
    path = root / 'connectors/teams/selection.json'
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


def configure_request():
    raw = sys.stdin.buffer.read(MAX_CONFIG + 1)
    require(len(raw) <= MAX_CONFIG)
    request = json.loads(raw)
    require(type(request) is dict and set(request) <= {'selectionToken', 'cachePath'})
    token = request.get('selectionToken')
    require(type(token) is str and re.fullmatch(r'[A-Za-z0-9_-]{12,128}', token))
    if 'cachePath' in request:
        require(os.name == 'posix')
        candidates = [absolute(request['cachePath'])]
    else:
        require(sys.platform == 'darwin')
        candidates = current_store.discover()
    require(candidates)
    return token, candidates


def portable_run(command):
    request = configure_request() if command == 'configure' else None
    path = portable_path()
    fd = portable_directory(path, create=command == 'configure')
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        try:
            config = read_config(fd, path.name)
        except FileNotFoundError:
            require(command == 'configure')
            config = None
        if command == 'configured-snapshot':
            return envelope(acquire(config['cache']), config['cache'],
                            bytes.fromhex(config['key']), bytes.fromhex(config['scope']))
        key = bytes.fromhex(config['key']) if config else secrets.token_bytes(32)
        token, candidates = request
        matches = []
        for candidate in candidates:
            cache = str(absolute(str(candidate)))
            view = acquire(cache)
            selection = action.extract(view, cache, key, snippet=token)
            require(not any(selection.stats.values()))
            for selected, _ in selection.matches:
                matches.append((cache, envelope(view, cache, key, selected)))
        require(len(matches) == 1)
        cache, snapshot = matches[0]
        save_config(fd, path.name, {'key': key.hex(), 'cache': cache, 'scope': snapshot['scope']})
        return snapshot
    finally:
        os.close(fd)


def run(command):
    if command in ('configure', 'configured-snapshot'):
        return portable_run(command)
    path = absolute(os.environ.get('EXANGELOS_TEAMS_CONFIG'))
    fd = config_directory(path)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if command == 'snapshot':
            config = read_config(fd, path.name)
            return envelope(acquire(config['cache']), config['cache'],
                            bytes.fromhex(config['key']), bytes.fromhex(config['scope']))
        require(command == 'setup')
        require(not path.resolve().is_relative_to(Path(__file__).resolve().parents[1]))
        try:
            config = read_config(fd, path.name)
            key = bytes.fromhex(config['key'])
        except FileNotFoundError:
            key = secrets.token_bytes(32)
        cache = str(absolute(os.environ.get('EXANGELOS_TEAMS_CACHE')))
        snippet = action.c.private_snippet()
        view = acquire(cache)
        selection = action.extract(view, cache, key, snippet=snippet)
        require(not any(selection.stats[name] for name in ('invalid', 'walk_gaps', 'acquisition_gaps', 'ambiguous'))
                and len(selection.matches) == 1)
        selected, _ = next(iter(selection.matches))
        envelope(view, cache, key, selected)
        save_config(fd, path.name, {'key': key.hex(), 'cache': cache, 'scope': selected.hex()})
        return None
    finally:
        os.close(fd)


def main():
    try:
        limits()
        require(len(sys.argv) == 2)
        result = run(sys.argv[1])
        if result is not None:
            sys.stdout.write(json.dumps(result, separators=(',', ':')) + '\n')
        return 0
    except BaseException:
        sys.stderr.write('teams_bridge_unavailable\n')
        return 1


if __name__ == '__main__':
    sys.exit(main())
