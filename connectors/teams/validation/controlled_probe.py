"""Two observations of privately selected cached candidates; aggregate output only."""
import json
import math
import os
import resource
import sys
import termios
import time

import current_store
import semantics as sem
import serialization as s
from probe import prefix

KEYS = ('observation', 'ready', 'failed', 'selection_matches', 'candidates',
        'new_candidates', 'candidate_version_changes', 'record_version_changes',
        'unchanged_candidates', 'missing_candidates', 'unversioned_candidates',
        'ambiguous_candidates', 'unsupported', 'invalid', 'walk_gaps',
        'acquisition_gaps', 'scope_missing', 'proven_message_events',
        'proven_deletions', 'signed_in_authority')


def counts():
    return dict.fromkeys(KEYS, 0)


def emit(out):
    if type(out) is not dict or set(out) != set(KEYS):
        raise ValueError()
    if any(type(v) is not int or v < 0 for v in out.values()):
        raise ValueError()
    print(json.dumps(out, sort_keys=True), flush=True)


def private_snippet():

    fd = os.open('/dev/tty', os.O_RDWR | os.O_NOCTTY)
    saved = termios.tcgetattr(fd)
    try:
        mode = termios.tcgetattr(fd)
        mode[3] &= ~(termios.ECHO | termios.ECHONL)
        termios.tcsetattr(fd, termios.TCSAFLUSH, mode)
        os.write(fd, b'Private existing-message snippet (12-1024 characters), then Return: ')
        data = os.read(fd, 4096)
        if not data.endswith(b'\n'):
            raise ValueError()
        snippet = data[:-1].decode('utf-8')
        if not 12 <= len(snippet) <= 1024:
            raise ValueError()
        return snippet
    finally:
        termios.tcsetattr(fd, termios.TCSAFLUSH, saved)
        os.write(fd, b'\n')
        os.close(fd)


def scalar(v):
    return type(v) in (str, int) or (type(v) is float and math.isfinite(v))


def extract(view, origin, snippet=None, selected=None):
    """Keep only identity, scope and version markers beyond decoded row lifetime."""
    result, matches, out = {}, set(), counts()
    for k, value in view.items():
        try:
            db, store, index, _ = prefix(k)
            if not (db and store and index == 1):
                continue
            obj = s._decode(value)
            record_version = s.Reader(value).uint()
            walk = dict.fromkeys(sem.COUNTERS, 0)
            for node, _, _, _ in sem._walk(obj, walk):
                normalized = {}
                duplicate = False
                for field, v in node.items():
                    n = sem._norm(field)
                    if n in normalized:
                        duplicate = True
                    normalized[n] = v
                if duplicate:
                    out['walk_gaps'] += 1
                    continue
                identity = next((normalized[f] for f in ('messageid', 'id', 'clientmessageid')
                                 if type(normalized.get(f)) in (str, int)), None)
                scopes = {v for f, v in normalized.items() if f in (sem.FIELDS['scope'] - {'teamid'}) and type(v) is str and v}
                created = any(f in sem.FIELDS['created'] and s._timestamp(v) for f, v in normalized.items())
                body = any(f in sem.FIELDS['body'] and (sem._present(v) or type(v) is dict) for f, v in normalized.items())
                if identity is None or not scopes or not created or not body:
                    continue

                if len(scopes) != 1:
                    out['ambiguous_candidates'] += 1
                    continue
                scope = (origin, db, next(iter(scopes)))
                if snippet is not None and any(f in ('body', 'content') and type(v) is str and snippet in v
                                               for f, v in normalized.items()):
                    matches.add(scope)
                if selected is not None and scope != selected:
                    continue
                versions = tuple(sorted((f, type(v).__name__, v) for f, v in normalized.items()
                                        if f in sem.FIELDS['modified'] and scalar(v)))
                marker = (scope, type(identity).__name__, identity)
                versions = (versions, record_version)
                if marker in result and result[marker] != versions:
                    result[marker] = None
                else:
                    result.setdefault(marker, versions)
            out['walk_gaps'] += walk['walk_limited']
        except s.Unsupported:
            out['unsupported'] += 1
        except Exception:
            out['invalid'] += 1
    out['ambiguous_candidates'] += sum(v is None for v in result.values())
    return result, matches, out


def observe(snippet=None, selected=None):
    result, matches, out = {}, set(), counts()
    try:
        paths = current_store.discover()
        if not paths:
            out['acquisition_gaps'] += 1
        for path in paths:
            try:
                view, storage = current_store.current_view(path)
                if not storage['stable'] or not storage['checksums_verified']:
                    raise ValueError()
                rows, found, stats = extract(view, str(path), snippet, selected)
                del view
                result.update(rows)
                matches.update(found)
                for field in ('unsupported', 'invalid', 'walk_gaps', 'ambiguous_candidates'):
                    out[field] += stats[field]
            except Exception:
                out['acquisition_gaps'] += 1
    except Exception:
        out['acquisition_gaps'] += 1
    return result, matches, out


def compare(before, after, out):
    out['candidates'] = len(after)
    out['missing_candidates'] = len(before.keys() - after.keys())
    out['new_candidates'] = len(after.keys() - before.keys())
    out['unversioned_candidates'] = sum(v is not None and not v[0] for v in after.values())
    for key in before.keys() & after.keys():
        old, new = before[key], after[key]
        if old is None or new is None:
            continue
        out['candidate_version_changes'] += old[0] != new[0]
        out['record_version_changes'] += old[1] != new[1]
        out['unchanged_candidates'] += old == new
    out['scope_missing'] = int(not after)
    return out


def run(read_private=private_snippet, acquire=observe, wait=time.sleep):
    snippet = read_private()
    before, matches, out = acquire(snippet=snippet)
    snippet = None
    out['selection_matches'] = len(matches)
    out['observation'] = 1
    if len(matches) != 1 or out['acquisition_gaps'] or out['walk_gaps'] or out['invalid']:
        out['failed'] = 1
        emit(out)
        return 1
    selected = matches.pop()
    before = {k: v for k, v in before.items() if k[0] == selected}
    out['candidates'] = len(before)
    out['unversioned_candidates'] = sum(v is not None and not v[0] for v in before.values())
    out['ready'] = 1
    emit(out)
    wait(60)
    after, _, out = acquire(selected=selected)
    out['observation'] = 2
    out['selection_matches'] = 1

    if out['acquisition_gaps'] or out['invalid'] or out['walk_gaps']:
        out['failed'] = 1
        emit(out)
        return 1
    emit(compare(before, after, out))
    return 0


def main():
    try:
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        if len(sys.argv) != 1:
            raise ValueError()
        return run()
    except BaseException:
        out = counts()
        out['failed'] = 1
        emit(out)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
