"""Action-correlated cache observations, never connector events."""
from html.parser import HTMLParser
import hashlib
import hmac
import json
import math
import os
import resource
import sys
import stat
import termios
import time
from dataclasses import dataclass, field

import controlled_probe as c
import current_store
import semantics as sem
import serialization as s
import reactions
from probe import prefix


@dataclass(repr=False)
class Snapshot:
    rows: dict = field(default_factory=dict)
    matches: set = field(default_factory=set)
    stats: dict = field(default_factory=lambda: dict.fromkeys(
        ('unsupported', 'invalid', 'walk_gaps', 'acquisition_gaps', 'ambiguous'), 0))


def fingerprint(key, domain, value):
    budget = [4096, 65536]
    active = set()

    def check(v, depth=0):
        budget[0] -= 1
        if budget[0] < 0 or depth > 32:
            raise ValueError()
        if type(v) is str:
            budget[1] -= len(v.encode('utf-8'))
            if budget[1] < 0:
                raise ValueError()
        elif v is None or type(v) in (bool, int):
            pass
        elif type(v) is float and math.isfinite(v):
            pass
        elif type(v) in (list, dict):
            if id(v) in active:
                raise ValueError()
            active.add(id(v))
            if type(v) is dict:
                for k, item in v.items():
                    if type(k) is not str:
                        raise ValueError()
                    check(k, depth + 1)
                    check(item, depth + 1)
            else:
                for item in v:
                    check(item, depth + 1)
            active.remove(id(v))
        else:
            raise ValueError()
    check(value)
    encoded = json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()
    return hmac.new(key, domain.encode() + b'\0' + encoded, hashlib.sha256).digest()


def representation(key, domain, values):
    if not values:
        return (0, None)
    state = 1 if all(v is None for v in values.values()) else 2 if all(
        v == [] or v == {} or v == '' for v in values.values()) else 3
    try:
        return (state, fingerprint(key, domain, values))
    except (ValueError, TypeError, OverflowError, RecursionError):
        return (4, None)


EXTRACT_FIELDS = frozenset().union(*(sem.FIELDS[f] for f in ('identity', 'scope', 'created', 'body', 'modified')), (
    'properties', 'reactions', 'reaction', 'emotions', 'emotionalexpressions',
    'replytoid', 'parentmessageid', 'replytomessageid'))


def candidate_shape(node, require_body=True):
    fields = [(sem._norm(name), value) for name, value in node.items()]
    return (any(name in sem.FIELDS['identity'] and type(value) in (str, int) for name, value in fields)
        and any(name in sem.FIELDS['scope'] - {'teamid'} and type(value) is str and value for name, value in fields)
        and any(name in sem.FIELDS['created'] and s._timestamp(value) for name, value in fields)
        and (not require_body or any(name in sem.FIELDS['body'] for name, _ in fields)))


def candidate_fields(node):
    result = {}
    for name, value in node.items():
        field = sem._norm(name)
        if field not in EXTRACT_FIELDS:
            continue
        if field in result:
            raise ValueError()
        result[field] = value
    return result


class ReplyQuotes(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parents = []
        self.stack = []
        self.tags = 0

    def handle_starttag(self, tag, attrs):
        self.tags += 1
        if self.tags > 4096:
            raise ValueError()
        if tag != 'blockquote':
            return
        reply = ('itemtype', 'http://schema.skype.com/Reply') in attrs
        self.stack.append(reply)
        if len(self.stack) > 32:
            raise ValueError()
        if reply:
            fields = dict(attrs)
            if (len(fields) != len(attrs) or 'itemscope' not in fields
                    or not fields.get('itemid') or not fields['itemid'].strip()):
                raise ValueError()
            self.parents.append(fields['itemid'])

    def handle_endtag(self, tag):
        if tag == 'blockquote' and self.stack:
            self.stack.pop()

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag == 'blockquote' and self.stack[-1]:
            raise ValueError()
        self.handle_endtag(tag)


def parent_references(normalized, key):
    parents = set()
    identity = next((normalized[f] for f in ('messageid', 'id', 'clientmessageid')
                     if type(normalized.get(f)) in (str, int)), None)
    for name in ('replytoid', 'parentmessageid', 'replytomessageid'):
        value = normalized.get(name)
        if value is None or value == '':
            continue
        if type(value) not in (str, int):
            raise ValueError()
        if name == 'parentmessageid' and type(value) is type(identity) and value == identity:
            continue
        parents.add(fingerprint(key, 'identity', value))
    for name in ('body', 'content'):
        value = normalized.get(name)
        if type(value) is not str:
            continue
        if len(value.encode('utf-8')) > 65536:
            raise ValueError()
        parser = ReplyQuotes()
        parser.feed(value)
        parser.close()
        if any(parser.stack):
            raise ValueError()
        for parent in parser.parents:
            parents.add(fingerprint(key, 'identity', parent))
    if len(parents) > 1:
        raise ValueError()
    return frozenset(parents)


def extract(view, origin, key, snippet=None, selected=None):
    result = Snapshot()
    for raw_key, value in view.items():
        try:
            db, store, index, _ = prefix(raw_key)
            if not (db and store and index == 1):
                continue
            obj = s._decode(value)
            record = fingerprint(key, 'record', [raw_key.hex(), s.Reader(value).uint()])
            walk = dict.fromkeys(sem.COUNTERS, 0)
            for node, _, _, _ in sem._walk(obj, walk):
                if not candidate_shape(node):
                    continue
                try:
                    normalized = candidate_fields(node)
                except ValueError:
                    result.stats['walk_gaps'] += 1
                    continue
                identity = next((normalized[f] for f in ('messageid', 'id', 'clientmessageid')
                                 if type(normalized.get(f)) in (str, int)), None)
                scopes = {v for f, v in normalized.items()
                          if f in sem.FIELDS['scope'] - {'teamid'} and type(v) is str and v}
                if identity is None or not scopes or not any(
                    f in sem.FIELDS['created'] and s._timestamp(v) for f, v in normalized.items()
                ) or not any(f in sem.FIELDS['body'] for f in normalized):
                    continue
                if len(scopes) != 1:
                    result.stats['ambiguous'] += 1
                    continue
                scope = fingerprint(key, 'scope', [origin, db, next(iter(scopes))])
                if selected is not None and scope != selected:
                    continue
                marker = (scope, fingerprint(key, 'identity', identity))
                if snippet is not None and any(
                    f in ('body', 'content') and type(v) is str and snippet in v
                    for f, v in normalized.items()
                ):
                    result.matches.add(marker)
                body = representation(key, 'body', {f: v for f, v in normalized.items() if f in ('body', 'content')})
                reaction = representation(key, 'reaction', {f: v for f, v in normalized.items()
                    if f in ('reactions', 'reaction', 'emotions', 'emotionalexpressions')})
                native_members = reactions.members(node)
                if native_members is not None:
                    reaction = representation(key, 'reaction', {'members': native_members})
                version = representation(key, 'version', {f: v for f, v in normalized.items()
                    if f in sem.FIELDS['modified']})
                parents = parent_references(normalized, key)
                semantic = (body, reaction, version, frozenset(parents))
                old = result.rows.get(marker)
                if marker in result.rows and (old is None or old[0] != semantic):
                    result.rows[marker] = None
                elif old is not None:
                    result.rows[marker] = (semantic, old[1] | {record})
                else:
                    result.rows[marker] = (semantic, frozenset((record,)))
            result.stats['walk_gaps'] += walk['walk_limited']
        except s.Unsupported:
            result.stats['unsupported'] += 1
        except Exception:
            result.stats['invalid'] += 1
    result.stats['ambiguous'] += sum(v is None for v in result.rows.values())
    return result


def observe(key, snippet=None, selected=None):
    result = Snapshot()
    try:
        paths = current_store.discover()
        if not paths:
            result.stats['acquisition_gaps'] += 1
        for path in paths:
            try:
                view, storage = current_store.current_view(path)
                if not storage['stable'] or not storage['checksums_verified']:
                    raise ValueError()
                part = extract(view, str(path), key, snippet, selected)
                del view
                result.rows.update(part.rows)
                result.matches.update(part.matches)
                for name, count in part.stats.items():
                    result.stats[name] += count
            except Exception:
                result.stats['acquisition_gaps'] += 1
    except Exception:
        result.stats['acquisition_gaps'] += 1
    return result


def compare(before, after, target):
    result = dict.fromkeys(('new_candidates', 'supported_new_candidates', 'missing_candidates', 'new_parent_matches',
        'target_missing', 'target_ambiguous', 'target_body_changes', 'target_reaction_changes',
        'target_version_changes', 'target_record_changes', 'target_body_stable',
        'reaction_before_state', 'reaction_after_state', 'reaction_state_changes',
        'proven_events', 'proven_removals'), 0)
    result['new_candidates'] = len(after.rows.keys() - before.rows.keys())
    result['supported_new_candidates'] = sum(row is not None and row[0][0][0] in (1, 2, 3)
        for marker, row in after.rows.items() if marker not in before.rows)
    result['missing_candidates'] = len(before.rows.keys() - after.rows.keys())
    result['new_parent_matches'] = sum(row is not None and row[0][0][0] in (1, 2, 3) and marker[0] == target[0] and row[0][3] == frozenset((target[1],))
        for marker, row in after.rows.items() if marker not in before.rows)
    if target not in before.rows or target not in after.rows:
        result['target_missing'] = 1
        return result
    old, new = before.rows[target], after.rows[target]
    if old is None or new is None:
        result['target_ambiguous'] = 1
        return result
    for index, name in enumerate(('body', 'reaction', 'version')):
        a, b = old[0][index], new[0][index]
        result['target_' + name + '_changes'] = int(a[0] in (1, 2, 3) and b[0] in (1, 2, 3) and a != b)
    result['target_body_stable'] = int(old[0][0][0] in (1, 2, 3) and old[0][0] == new[0][0])
    result['target_record_changes'] = int(old[1] != new[1])
    result['reaction_before_state'] = old[0][1][0]
    result['reaction_after_state'] = new[0][1][0]
    result['reaction_state_changes'] = int(old[0][1][0] != new[0][1][0])
    return result


STAGES = (
    'Make no intentional change.',
    'Send one new message in the selected conversation.',
    'Reply to the originally selected message.',
    'Edit the originally selected message.',
    'Add one reaction to the originally selected message.',
    'Remove that same reaction from the originally selected message.',
)
KEYS = frozenset(compare(Snapshot(), Snapshot(), (b'', b''))) | frozenset(Snapshot().stats) | frozenset((
    'stage', 'ready', 'failed', 'inconclusive', 'action_completed', 'selection_matches',
    'elapsed_ms', 'observation_over_60_seconds', 'reaction_return_to_baseline'))


def counts(stage=0):
    result = dict.fromkeys(KEYS, 0)
    result['stage'] = stage
    return result


def emit(result):
    if type(result) is not dict or set(result) != KEYS or any(type(v) is not int or v < 0 for v in result.values()):
        raise ValueError()
    print(json.dumps(result, sort_keys=True), flush=True)


def private_prompt(text):
    fd = os.open('/dev/tty', os.O_RDWR | os.O_NOCTTY)
    saved = None
    try:
        saved = termios.tcgetattr(fd)
        mode = termios.tcgetattr(fd)
        mode[3] &= ~(termios.ECHO | termios.ECHONL)
        termios.tcsetattr(fd, termios.TCSAFLUSH, mode)
        os.write(fd, text.encode())
        value = os.read(fd, 16)
        if value not in (b'\n', b'y\n', b'n\n'):
            raise ValueError()
        return value.decode().strip()
    finally:
        try:
            if saved is not None:
                termios.tcsetattr(fd, termios.TCSAFLUSH, saved)
                os.write(fd, b'\n')
        finally:
            os.close(fd)


def private_file(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        before = os.fstat(fd)
        if (not stat.S_ISREG(before.st_mode) or before.st_uid != os.getuid()
                or before.st_mode & 0o077 or not 12 <= before.st_size <= 4098):
            raise ValueError()
        data = bytearray()
        while len(data) <= before.st_size:
            part = os.read(fd, before.st_size + 1 - len(data))
            if not part:
                break
            data.extend(part)
        if len(data) != before.st_size or current_store.signature(before) != current_store.signature(os.fstat(fd)):
            raise ValueError()
        snippet = data.decode('utf-8')
        if snippet.endswith('\n'):
            snippet = snippet[:-1]
            if snippet.endswith('\r'):
                snippet = snippet[:-1]
        if not 12 <= len(snippet) <= 1024 or not snippet.strip() or '\x00' in snippet:
            raise ValueError()
        return snippet
    finally:
        os.close(fd)


class Coordinator:
    def __init__(self, stream):
        self.stream = stream
        self.stage = -1

    def command(self, allowed):
        line = self.stream.readline(32)
        if line not in allowed:
            raise ValueError()
        return line

    def prompt(self, text):
        if text.startswith('Was this stage'):
            return 'y' if self.command((b'confirmed\n', b'abort\n')) == b'confirmed\n' else 'n'
        self.stage += 1
        if self.command((f'ready {self.stage}\n'.encode(), b'abort\n')) == b'abort\n':
            raise ValueError()
        return ''

    def wait(self, seconds):
        if self.command((f'observe {self.stage}\n'.encode(), b'abort\n')) == b'abort\n':
            raise ValueError()


def usable(snapshot, target):
    return not any(snapshot.stats[k] for k in ('invalid', 'walk_gaps', 'acquisition_gaps', 'ambiguous')) and (
        target in snapshot.rows and snapshot.rows[target] is not None and snapshot.rows[target][0][0][0] in (1, 2, 3))


def observed(stage, result):
    if result['target_missing'] or result['target_ambiguous']:
        return False
    if stage == 0:
        return not any(result[k] for k in ('new_candidates', 'missing_candidates', 'target_body_changes',
            'target_reaction_changes', 'target_version_changes', 'target_record_changes', 'reaction_state_changes'))
    if stage == 1:
        return result['supported_new_candidates'] > 0
    if stage == 2:
        return result['new_parent_matches'] > 0
    if stage == 3:
        return result['target_body_changes'] > 0
    return result['target_body_stable'] == 1 and result['target_reaction_changes'] > 0


def run(read_private=c.private_snippet, acquire=observe, prompt=private_prompt,
        wait=time.sleep, clock=time.monotonic, output=emit):
    key = os.urandom(32)
    snippet = read_private()
    prompt(STAGES[0] + ' Return when ready; the window starts at ready=1: ')
    before = acquire(key, snippet=snippet)
    snippet = None
    selection_count = len(before.matches)
    if selection_count != 1:
        result = counts()
        result.update(before.stats, failed=1, inconclusive=1, selection_matches=selection_count)
        output(result)
        return 1
    target = next(iter(before.matches))
    before.matches.clear()
    before.rows = {k: v for k, v in before.rows.items() if k[0] == target[0]}
    reaction_baseline = None
    for stage, instruction in enumerate(STAGES):
        if stage:
            prompt('Next stage: ' + instruction + ' Do not act yet. Return when ready; act at ready=1: ')
            before = acquire(key, selected=target[0])
        result = counts(stage)
        result.update(before.stats, selection_matches=1)
        if not usable(before, target):
            result.update(failed=1, inconclusive=1)
            output(result)
            return 1
        if stage == 4:
            reaction_baseline = before.rows[target][0][1]
        result['ready'] = 1
        start = clock()
        output(result)
        wait(60)
        after = acquire(key, selected=target[0])
        elapsed_ms = max(0, int((clock() - start) * 1000))
        result = counts(stage)
        result.update(after.stats, selection_matches=1, elapsed_ms=elapsed_ms,
            observation_over_60_seconds=int(elapsed_ms > 60000))
        if not usable(after, target):
            result.update(failed=1, inconclusive=1)
            output(result)
            return 1
        result.update(compare(before, after, target))
        result['action_completed'] = int(prompt('Was this stage completed exactly as instructed during the window? y/n: ') == 'y')
        if stage == 5:
            result['reaction_return_to_baseline'] = int(reaction_baseline is not None and
                reaction_baseline[0] in (1, 2, 3) and after.rows[target][0][1] == reaction_baseline)
        result['inconclusive'] = int(not result['action_completed'] or not observed(stage, result))
        output(result)
        if result['inconclusive']:
            return 1
    return 0


def main():
    try:
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        if len(sys.argv) == 4 and sys.argv[1] == '--selection-file' and sys.argv[3] == '--coordinated':
            control = Coordinator(sys.stdin.buffer)
            return run(read_private=lambda: private_file(sys.argv[2]),
                       prompt=control.prompt, wait=control.wait)
        if len(sys.argv) != 1:
            raise ValueError()
        return run()
    except BaseException:
        result = counts()
        result.update(failed=1, inconclusive=1)
        emit(result)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
