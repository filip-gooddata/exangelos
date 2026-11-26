"""Private, atomic records for Slack selections and their verified thread bindings."""
import contextlib
import fcntl
import json
import os
from pathlib import Path
import stat
import tempfile
import time

from state_directory import state_directory


def require(value):
    if not value:
        raise ValueError('private state')


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
        raw = stream.read(65536 + 1)
    require(len(raw) <= 65536)
    return json.loads(raw, object_pairs_hook=unique_object)


def unique_object(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError('duplicate')
        value[key] = item
    return value


def optional(path):
    try:
        return read_json(path)
    except FileNotFoundError:
        return None
