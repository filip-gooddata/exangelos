"""Synthetic installed-archive acceptance. Requires Python 3.10+, Bun and installed workspace dependencies.

Usage: python3 connectors/slack/test/archive_validation.py /absolute/new-evidence-dir
Build the current worktree with the official packer. All runtime inputs and homes are synthetic.
"""
from copy import deepcopy
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import selectors
import shutil
import signal
import sqlite3
import subprocess
import sys
import tarfile
import time


REPO = Path(__file__).resolve().parents[3]
BUN = shutil.which('bun')


def check(ok, label):
    if not ok:
        raise AssertionError(label)


def command(args, cwd, log, home, timeout=180):
    env = dict(PATH=os.environ['PATH'], HOME=str(home))
    with log.open('wb') as out:
        result = subprocess.run(args, cwd=cwd, env=env, stdout=out, stderr=subprocess.STDOUT, timeout=timeout)
    check(result.returncode == 0, 'command failed: ' + log.name)


def inventory(root):
    return [{'path': str(p.relative_to(root)), 'sha256': hashlib.sha256(p.read_bytes()).hexdigest(),
             'size': p.stat().st_size, 'mode': oct(p.stat().st_mode & 0o7777), 'mtime_ns': p.stat().st_mtime_ns}
            for p in sorted(root.rglob('*')) if p.is_file()]


class Wire:
    def __init__(self, installed, home, path=None):
        env = {'PATH': str(path) if path is not None else os.environ['PATH']}
        env.update(HOME=str(home), EXANGELOS_HOME=str(home / 'state'), XDG_DATA_HOME=str(home / 'xdg'),
                   XDG_CONFIG_HOME=str(home / 'config'), XDG_CACHE_HOME=str(home / 'cache'),
                   APPDATA=str(home / 'roaming'), LOCALAPPDATA=str(home / 'local'))
        self.p = subprocess.Popen([BUN, 'dist/main.js'], cwd=installed, env=env,
                                  stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                  start_new_session=True)
        self.selector = selectors.DefaultSelector()
        self.selector.register(self.p.stdout, selectors.EVENT_READ, 'stdout')
        self.selector.register(self.p.stderr, selectors.EVENT_READ, 'stderr')
        self.buffer = b''
        self.id = 0

    def __enter__(self):
        return self

    def __exit__(self, *args):
        try:
            os.killpg(self.p.pid, signal.SIGTERM)
            self.p.wait(timeout=3)
        except (ProcessLookupError, subprocess.TimeoutExpired):
            try:
                os.killpg(self.p.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            self.p.wait(timeout=3)
        self.selector.close()
        for pipe in (self.p.stdin, self.p.stdout, self.p.stderr):
            pipe.close()

    def send(self, value):
        self.p.stdin.write((json.dumps(value) + '\n').encode())
        self.p.stdin.flush()

    def receive(self, timeout=12, quiet=False):
        check(not quiet or not self.buffer, 'unexpected output during quiet interval')
        deadline = time.monotonic() + timeout
        while b'\n' not in self.buffer:
            left = deadline - time.monotonic()
            if left <= 0:
                check(quiet and self.p.poll() is None, 'wire deadline or unexpected process exit')
                return None
            for key, _ in self.selector.select(left):
                data = os.read(key.fileobj.fileno(), 65536)
                check(bool(data), 'unexpected process EOF')
                check(key.data == 'stdout', 'unexpected stderr (contents suppressed)')
                check(not quiet, 'unexpected output during quiet interval')
                self.buffer += data
        line, self.buffer = self.buffer.split(b'\n', 1)
        check(not quiet, 'unexpected output during quiet interval')
        return json.loads(line)

    def request(self, tag, payload):
        self.id += 1
        self.send(dict(_tag='Request', id=str(self.id), tag=tag, payload=payload, headers=[]))
        return str(self.id)

    def call(self, tag, payload):
        identity = self.request(tag, payload)
        answer = self.receive()
        check(answer['_tag'] == 'Exit' and str(answer['requestId']) == identity, 'RPC exit envelope')
        check(answer['exit']['_tag'] == 'Success', 'RPC successful exit')
        return answer['exit']['value']

    def handshake(self):
        answer = self.call('Handshake', None)
        check(answer['protocolVersion'] == 1 and len(answer['catalogue']['eventTypes']) == 5, 'handshake')

    def configure(self, value, accepted=True):
        answer = self.call('Configure', {'values': value})
        check(answer['_tag'] == ('Accepted' if accepted else 'Rejected'), 'configure result')
        return answer

    def watch(self, selection, cursor=None):
        payload = dict(parameters={'selection': selection}, eventTypes=[])
        if cursor is not None:
            payload['cursor'] = cursor
        return self.request('Watch', payload)

    def chunk(self, identity):
        answer = self.receive()
        check(answer['_tag'] == 'Chunk' and str(answer['requestId']) == identity, 'watch chunk')
        self.send(dict(_tag='Ack', requestId=identity))
        return answer['values']


def describe(wire, selection, scope=None, valid=True):
    parameters = {'selection': selection}
    if scope is not None:
        parameters['scope'] = scope
    answer = wire.call('Describe', {'parameters': parameters})
    if not valid:
        check(answer['_tag'] == 'Invalid', 'subject rejected')
        return answer['reason']
    check(answer['_tag'] == 'Described', 'subject described')
    handle = answer['parameters']['selection']
    check(re.fullmatch(r'scope-[a-f0-9]{64}', handle) and answer['parameters'] == {'selection': handle},
          'normalized private handle')
    check(answer['subject'] == 'slack:' + handle[6:] and bool(answer['label']), 'subject and label')
    return handle


def failed_watch(wire, selection, cursor=None):
    identity = wire.watch(selection, cursor)
    answer = wire.receive()
    check(answer['_tag'] == 'Exit' and str(answer['requestId']) == identity and
          answer['exit']['_tag'] == 'Failure' and 'SourceFailed' in json.dumps(answer), 'watch refused')


def check_wake(event, handle, home, label, preview=None, *, once=False):
    ts = event['payload']['messageTs']
    seconds, fraction = ts.split('.')
    instant = datetime.fromtimestamp(int(seconds), timezone.utc)
    timing = f'message time {instant:%Y-%m-%d %H:%M:%S}.{fraction} UTC'
    if event['type'] in ('message.edited', 'reaction.added', 'reaction.removed'):
        observed = datetime.fromisoformat(event['occurredAt'].replace('Z', '+00:00'))
        timing += f', observed {observed:%Y-%m-%d %H:%M:%S}.{observed.microsecond // 1000:03d} UTC'
    summary = f'{label} ({timing})'
    if preview is not None:
        summary += ' | Untrusted message excerpt: ' + json.dumps(preview)
    check(event['summary'] == summary, f"{event['type']} summary: {event['summary']!r}")
    check(('preview' in event['payload']) == (preview is not None) and event['payload'].get('preview') == preview,
          'preview presence and contents')
    subject = 'slack:' + handle[6:]
    capture = subprocess.run([BUN, str(Path(__file__).with_name('archive_wake.ts'))], cwd=REPO,
                             env={'HOME': str(home), 'PATH': os.environ['PATH']}, timeout=20,
                             input=json.dumps(dict(event=event, subject=subject, once=once)), capture_output=True, text=True)
    check(capture.returncode == 0, capture.stderr)
    heading = (f'sub_7f3k has ended (slack, {subject})\nIt reached its number of events.' if once
               else f'1 event on sub_7f3k (slack, {subject})')
    expected = (f'{heading}\n  #1 {event["type"]}   {summary}\n'
                'Read  exangelos events sub_7f3k\nAck   exangelos ack sub_7f3k --through 1')
    check(json.loads(capture.stdout) == [dict(program='/fake/bin/t3', args=['thread', 'send', '--', 'fixture', '-'],
                                               stdin=expected)], 'rendered T3 command and stdin')
    with (home.parent / 'rendered-wakes.jsonl').open('a') as log:
        log.write(capture.stdout.strip() + '\n')


def exercise(installed, home):
    sys.dont_write_bytecode = True
    sys.path.insert(0, str(REPO / 'connectors/slack/direct'))
    from observation import token
    from source import inventory as cache_inventory
    from test_direct import CHANNEL, TIME, SELECTION, fixture
    from test_source import database

    app = home / 'Library/Application Support/Slack/IndexedDB'
    home.mkdir()
    absent = home / 'absent-app'
    absent.mkdir()
    with Wire(installed, absent) as wire:
        wire.handshake()
        wire.configure(dict(subscriptionAccess='persisted-cache', cacheRoot=str(absent / 'missing')))
        describe(wire, CHANNEL, valid=False)
        wire.receive(1.2, quiet=True)
    app.mkdir(parents=True)
    sentinel = app / 'https_app.slack.com_0.indexeddb.leveldb/000002.log'
    sentinel.parent.mkdir()
    sentinel.write_bytes(b'synthetic unread sentinel')
    os.utime(sentinel, ns=(1000000000, 1000000000))
    empty_path = home / 'empty-path'
    empty_path.mkdir()
    config = dict(cacheRoot=str(app), subscriptionAccess='persisted-cache', pollIntervalMs='1000')
    with Wire(installed, home, empty_path) as wire:
        wire.handshake()
        describe(wire, CHANNEL, valid=False)
        wire.configure(config)
        describe(wire, CHANNEL, valid=False)
        wire.receive(1.2, quiet=True)
    private = home / 'state/connector-state/slack'
    private.mkdir(parents=True, mode=0o700)
    with Wire(installed, home) as wire:
        wire.handshake()
        describe(wire, CHANNEL, valid=False)
        wire.configure({'sourceMode': 'pinned-cache'}, accepted=False)
        failed_watch(wire, 'selected')
        wire.configure(dict(config, subscriptionAccess='disabled'))
        describe(wire, CHANNEL, valid=False)
        wire.receive(1.2, quiet=True)
    check(sentinel.stat().st_atime_ns == 1000000000, 'cache touched before consent')

    state = fixture()
    state['bootData']['team_domain'] = 'fixture'
    state['channels'] = {CHANNEL: {'id': CHANNEL, 'name': 'fixture'}}
    state['users'] = {'U0000002': {'profile': {'display_name': 'Fixture Avery'}}}
    messages = state['messages'][CHANNEL]
    other = '1700000001.000001'

    def add(ts, parent=None):
        message = {'ts': ts, 'user': 'U0000002', 'type': 'message', 'text': 'synthetic message', '_rxn_key': f'message-{ts}-{CHANNEL}'}
        if parent is not None:
            message['thread_ts'] = parent
        messages[ts] = message

    add(other)
    dm, group = 'D0000002', 'G0000003'
    state['messages'].update({dm: {}, group: {}})
    database(app, state)
    secret = 'ab' * 32
    key = bytes.fromhex(token(bytes.fromhex(secret), 'subscription-key-v1', str(app), '1', CHANNEL))
    epoch = cache_inventory(app)[1]["database"]
    scope = token(key, 'selected-scope-v1', *SELECTION[:2], [CHANNEL], epoch)
    legacy = 'scope-' + scope
    request = dict(root=str(app), key=key.hex(), expectedScope=scope,
                   selection=dict(workspace=SELECTION[0], owner=SELECTION[1], conversations=[CHANNEL]))
    previous = dict(request=request, location='custom', epoch=epoch, revision='1')
    old_files = {'subscriptions-key.json': secret, legacy + '.json': dict(previous, custom=str(app)),
                 'setup.json': dict(previous, version=1,
                                    selector=token(key, 'setup-conversation-v1', [None, CHANNEL], str(app), '1'))}
    for name, value in old_files.items():
        path = private / name
        path.write_text(json.dumps(value))
        path.chmod(0o600)
    original = inventory(private)
    top = f'{CHANNEL}:{TIME}'
    with Wire(installed, home) as wire:
        wire.configure(config)
        for selection in ('selected', legacy):
            describe(wire, selection, valid=False)
            failed_watch(wire, selection)
        reason = describe(wire, top, valid=False)
        check(all(option in reason for option in ('scope=conversation', 'scope=replies')), 'actionable top-level choice')
        conversation = describe(wire, top, 'conversation')
        replies = describe(wire, top, 'replies')
        check(describe(wire, CHANNEL) == conversation, 'canonical conversation')
        distinct = {conversation, replies, describe(wire, dm), describe(wire, group)}
        check(len(distinct) == 4, 'distinct D/C/G and thread subjects')
        cursors = {}
        for handle in (conversation, replies):
            batch = wire.chunk(wire.watch(handle))
            check(len(batch) == 1 and batch[0]['_tag'] == 'Cursor', 'silent baseline')
            cursors[handle] = batch[0]['cursor']

    def timestamp(micros):
        seconds, fraction = divmod(micros, 10**6)
        return f'{seconds}.{fraction:06d}'

    def current_timestamp():
        return timestamp(time.time_ns() // 1000)

    outside_ts = current_timestamp()
    add(outside_ts, other)
    database(app, state, sequence=30)

    def resume(handle, previews=None):
        with Wire(installed, home) as wire:
            wire.configure(config if previews is None else dict(config, messagePreviews=previews))
            return wire.chunk(wire.watch(handle, cursors[handle]))

    outside = resume(replies)
    check(len(outside) == 1 and outside[0]['_tag'] == 'Cursor', 'unrelated reply filtered')
    cursors[replies] = outside[0]['cursor']
    reply = current_timestamp()
    add(reply, TIME)
    messages[TIME]['text'] += ' synthetic edit'
    database(app, state, sequence=50)
    batches = {}
    for handle, expected in ((conversation, ['thread.reply', 'thread.reply', 'message.edited']),
                             (replies, ['thread.reply'])):
        batch = resume(handle)
        expected_context = {}
        for ts, parent in ((TIME, None), (reply, TIME), (outside_ts, other)):
            link = f'https://fixture.slack.com/archives/{CHANNEL}/p{ts.replace(".", "")}'
            context = dict(version=1, count=1, messageTs=ts, conversationLabel='Slack #fixture', permalink=link)
            if parent:
                context.update(sender='Fixture Avery', permalink=f'{link}?thread_ts={parent}&cid={CHANNEL}')
            expected_context[ts] = context
        delivered = [item['event']['payload'] for item in batch]
        wanted = [TIME, reply, outside_ts] if handle == conversation else [reply]
        check(sorted(delivered, key=lambda ctx: ctx['messageTs']) == [expected_context[ts] for ts in sorted(wanted)],
              'complete message context for each delivery')
        check(sorted(item['event']['type'] for item in batch) == sorted(expected), 'scoped deliveries')
        check(len({item['event']['dedupeKey'] for item in batch}) == len(batch), 'distinct event keys')
        check(resume(handle) == batch, 'exact replay after restart')
        batches[handle] = batch
    with Wire(installed, home) as wire:
        wire.configure(config)
        permalink = f'https://fixture.slack.com/archives/{CHANNEL}/p{reply.replace(".", "")}?thread_ts={TIME}&cid={CHANNEL}'
        describe(wire, permalink.replace('fixture.slack.com', 'other.slack.com'), valid=False)
        check(describe(wire, permalink) == replies and describe(wire, reply) == replies, 'canonical reply references')
        failed_watch(wire, replies, cursors[conversation])
        wire.configure(dict(config, subscriptionAccess='disabled'))
        describe(wire, replies, valid=False)
        failed_watch(wire, replies)
        wire.configure(config)
        check(describe(wire, top, 'replies') == replies, 'stable handle after consent restored')
        saved = batches[replies][-1]['cursor']
        check(wire.chunk(wire.watch(replies, saved)) == [dict(_tag='Cursor', cursor=saved)], 'quiet recovery checkpoint')
        wire.receive(1.2, quiet=True)
    check_wake(batches[replies][0]['event'], replies, home, 'Thread reply by "Fixture Avery" in "Slack #fixture"')
    cursors[conversation] = batches[conversation][-1]['cursor']
    with Wire(installed, home) as wire:
        wire.configure(dict(config, messagePreviews='enabled'))
        check(describe(wire, CHANNEL) == conversation, 'preview opt-in preserves subject')
        saved = cursors[conversation]
        check(wire.chunk(wire.watch(conversation, saved)) == [dict(_tag='Cursor', cursor=saved)], 'preview change preserves checkpoint')
        wire.receive(1.2, quiet=True)

    now = time.time_ns() // 1000
    new, new_reply = timestamp(now - 1), timestamp(now)
    add(new)
    add(new_reply, TIME)
    messages[new].update(text='new excerpt', subtype=b'_')
    messages[new_reply]['text'] = 'reply excerpt'
    messages[TIME].update(text='edited excerpt', user='U0000003')
    state['reactions'][messages[TIME]['_rxn_key']] = [{'name': 'heart', 'count': 1, 'users': ['U0000002']}]
    database(app, state, sequence=55)
    enabled = resume(conversation, 'enabled')
    expected = {
        'message.new': ('New message by "Fixture Avery"', new, 'new excerpt'),
        'thread.reply': ('Thread reply by "Fixture Avery"', new_reply, 'reply excerpt'),
        'message.edited': ('Message edited (message author: "U0000003")', TIME, 'edited excerpt'),
        'reaction.added': ('Reaction added (message author: "U0000003")', TIME, None),
        'reaction.removed': ('Reaction removed (message author: "U0000003")', TIME, None),
    }
    check(sorted(item['event']['type'] for item in enabled) == sorted(expected), 'all enabled delivery kinds')
    for item in enabled:
        event = item['event']
        action, ts, preview = expected[event['type']]
        check(event['payload']['messageTs'] == ts, 'preview attached to the changed message')
        label = action + ' in "Slack #fixture"'
        check_wake(event, conversation, home, label, preview)
        if event['type'] == 'message.new':
            check_wake(event, conversation, home, label, preview, once=True)
    with Wire(installed, home) as wire:
        wire.configure(dict(config, messagePreviews='enabled'))
        scoped = wire.chunk(wire.watch(replies, batches[replies][-1]['cursor']))
        check(len(scoped) == 1 and scoped[0]['event']['type'] == 'thread.reply'
              and scoped[0]['event']['payload']['messageTs'] == new_reply
              and scoped[0]['event']['payload']['preview'] == 'reply excerpt', 'only selected reply excerpt delivered')
    check(resume(conversation, 'disabled') == enabled, 'disabled configuration preserves the committed edge')
    cursors[conversation] = enabled[-1]['cursor']
    messages[new]['text'] = 'disabled private text'
    database(app, state, sequence=60)
    disabled = resume(conversation, 'disabled')
    check(len(disabled) == 1 and disabled[0]['event']['type'] == 'message.edited', 'one future edit after opt-out')
    check_wake(disabled[0]['event'], conversation, home, 'Message edited (message author: "Fixture Avery") in "Slack #fixture"')
    with Wire(installed, home) as wire:
        wire.configure(config)
        dm_handle = describe(wire, dm)
        initial = wire.chunk(wire.watch(dm_handle))
        check(len(initial) == 1 and initial[0]['_tag'] == 'Cursor', 'empty DM baseline')
        cursors[dm_handle] = initial[0]['cursor']

    def add_dm(ts):
        state['messages'][dm][ts] = dict(ts=ts, type='message', text='synthetic DM',
                                         user='U0000002', _rxn_key=f'message-{ts}-{dm}')

    for i in range(19):
        add_dm(f'1600000000.{i:06d}')
    # All three were sent after Watch began. One enters the cache after a newer row.
    now = time.time_ns() // 1000
    fresh = [timestamp(t) for t in range(now - 2, now + 1)]
    add_dm(fresh[2])
    database(app, state, sequence=70)
    first_dm = resume(dm_handle)
    check(len(first_dm) == 1 and first_dm[0]['event']['type'] == 'message.new' and
          first_dm[0]['event']['payload']['messageTs'] == fresh[2], 'only genuinely new DM delivered')
    check(resume(dm_handle) == first_dm, 'identical DM replay')
    cursors[dm_handle] = first_dm[-1]['cursor']
    for ts in fresh[:2]:
        add_dm(ts)
    database(app, state, sequence=90)
    burst = resume(dm_handle)
    check(len(burst) == 2 and {i['event']['payload']['messageTs'] for i in burst} == set(fresh[:2])
          and all(i['event']['type'] == 'message.new' for i in burst)
          and len({i['event']['dedupeKey'] for i in burst}) == 2, 'distinct delayed DM arrivals')
    # A pre-context ledger edge has no payload field. Use the installed connector
    # to resume that exact synthetic edge and verify the original public shape.
    _, lineage, source = cursors[replies].split(':')
    with sqlite3.connect(private / 'ledger.sqlite3') as db:
        edge = json.loads(db.execute('SELECT result FROM edges WHERE lineage=? AND source=?',
                                     (lineage, source)).fetchone()[0])
        for event in edge['events']:
            del event['summary']
        db.execute('UPDATE edges SET result=? WHERE lineage=? AND source=?', (json.dumps(edge), lineage, source))
    prior = deepcopy(batches[replies])
    for item in prior:
        item['event']['summary'] = 'Selected Slack conversation changed in a persisted snapshot'
    check(resume(replies, 'enabled') == prior, 'exact pre-summary v1 replay with previews enabled')
    with sqlite3.connect(private / 'ledger.sqlite3') as db:
        db.execute('DELETE FROM watch_starts WHERE lineage=?', (lineage,))
        for event in edge['events']:
            del event['payload']
        db.execute('UPDATE edges SET result=? WHERE lineage=? AND source=?', (json.dumps(edge), lineage, source))
    legacy_batch = resume(replies, 'enabled')
    for item in prior:
        item['event']['payload'] = {'count': 1}
    check(legacy_batch == prior, 'exact pre-context count-only replay with previews enabled')
    cursors[replies] = legacy_batch[-1]['cursor']
    check(resume(replies) == scoped, 'committed successor replays before the legacy tip ends')
    cursors[replies] = scoped[-1]['cursor']
    end = resume(replies)
    check(len(end) == 1 and end[0]['_tag'] == 'End' and 'Create a new subscription' in end[0]['reason'],
          'legacy cursor tip ends with actionable reason')

    # Exercise the worker byte limits with the largest supported DM selection.
    cursors[dm_handle] = burst[-1]['cursor']
    peer = 'U0000002'
    name = '🌊' * 80
    state['channels'][dm] = {'id': dm, 'is_im': True, 'user': peer}
    state['users'][peer] = dict(id=peer, team=SELECTION[0], profile=None)
    state['members'] = {peer: dict(id=peer, team=SELECTION[0], profile=dict(display_name=name))}
    state['messages'][dm].clear()
    users = [f'U{i:07d}' for i in range(100)]
    for i in range(500):
        ts = f'1500000000.{i:06d}' if i < 499 else fresh[0]
        add_dm(ts)
        state['reactions'][f'message-{ts}-{dm}'] = [{'name': 'wave', 'users': users, 'count': 100}]
    state['messages'][dm][fresh[0]]['text'] = 'edited synthetic DM'
    database(app, state, sequence=110)
    boundary = resume(dm_handle, 'enabled')
    check(len(boundary) == 1 and boundary[0]['event']['type'] == 'message.edited'
          and boundary[0]['event']['payload']['sender'] == name
          and boundary[0]['event']['payload']['conversationLabel'] == 'Slack DM with ' + name,
          'full reaction snapshot preserves Unicode sender and conversation')
    check_wake(boundary[0]['event'], dm_handle, home,
               f'Message edited (message author: "{name}") in "Slack DM with {name}"', 'edited synthetic DM')
    final_state = inventory(private)
    check(all(entry in final_state for entry in original), 'legacy user state preserved')
    return dict(dmHistorySuppressed=19, dmArrivals=3, distinctSubjects=len(distinct), conversationEvents=len(batches[conversation]),
                repliesEvents=len(batches[replies]), exactReplays=2, renderedWakeChecks=9, legacyV1Replays=1, legacyPayloadReplays=1, preservedLegacyFiles=len(original))


def main():
    evidence = Path(sys.argv[1]).resolve()
    check(not evidence.is_relative_to(REPO), 'use a fresh evidence directory outside the worktree')
    evidence.mkdir(parents=True, mode=0o700, exist_ok=False)
    build_home = evidence / 'build-home'
    build_home.mkdir(mode=0o700)
    out = evidence / 'archives'
    command([BUN, 'packaging/src/cli/build-connectors.ts', '--connectors', 'connectors/slack', '--out', str(out)],
            REPO, evidence / 'packer.log', build_home)
    [official] = json.loads((out / 'official-connectors.json').read_text())
    manifest = json.loads((REPO / 'connectors/slack/connector.json').read_text())
    check(official['name'] == manifest['name'] == 'slack' and official['version'] == manifest['version'],
          'official connector metadata')
    archive = out / f"slack-{manifest['version']}.tar.gz"
    checksum = hashlib.sha256(archive.read_bytes()).hexdigest()
    check((out / 'SHA256SUMS').read_text() == f'{checksum}  {archive.name}\n', 'release checksum')
    installed = evidence / 'installed'
    installed.mkdir()
    expected = {'connector.json', manifest['entry']['path'], *manifest['files']}
    with tarfile.open(archive) as tar:
        members = tar.getmembers()
        check(len(members) == len(expected) and {m.name for m in members} == expected and
              all(m.isfile() and (installed / m.name).resolve().is_relative_to(installed) for m in members),
              'exact archive inventory')
        tar.extractall(installed, **({'filter': 'data'} if hasattr(tarfile, 'data_filter') else {}))
    before = inventory(installed)
    (evidence / 'inventory-before.json').write_text(json.dumps(before, indent=2))
    result = exercise(installed, evidence / 'synthetic-home')
    after = inventory(installed)
    (evidence / 'inventory-after.json').write_text(json.dumps(after, indent=2))
    check(before == after and hashlib.sha256(archive.read_bytes()).hexdigest() == checksum, 'immutable release files')
    for item in after:
        source = REPO / 'connectors/slack' / item['path']
        check(hashlib.sha256(source.read_bytes()).hexdigest() == item['sha256'],
              f"worktree changed since archive build: {item['path']}")
    result.update(version=manifest['version'], installedFiles=len(before), immutable=True,
                  directoryDigest=official['digest'], archiveSha256=checksum)
    (evidence / 'result.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result))


if __name__ == '__main__':
    main()
