"""Synthetic installed-archive acceptance. Requires Python 3.10+, Bun and installed workspace dependencies.

Usage: python3 connectors/slack/test/archive_validation.py /absolute/new-evidence-dir
Build the current worktree with the official packer. All runtime inputs and homes are synthetic.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import selectors
import shutil
import signal
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
    messages = state['messages'][CHANNEL]
    other = '1700000001.000001'

    def add(ts, parent=None):
        message = {'ts': ts, 'type': 'message', 'text': 'synthetic message', '_rxn_key': f'message-{ts}-{CHANNEL}'}
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

    add('1700000002.000001', other)
    database(app, state, sequence=30)

    def resume(handle):
        with Wire(installed, home) as wire:
            wire.configure(config)
            return wire.chunk(wire.watch(handle, cursors[handle]))

    outside = resume(replies)
    check(len(outside) == 1 and outside[0]['_tag'] == 'Cursor', 'unrelated reply filtered')
    cursors[replies] = outside[0]['cursor']
    reply = '1700000003.000001'
    add(reply, TIME)
    messages[TIME]['text'] += ' synthetic edit'
    database(app, state, sequence=50)
    batches = {}
    for handle, expected in ((conversation, ['thread.reply', 'thread.reply', 'message.edited']),
                             (replies, ['thread.reply'])):
        batch = resume(handle)
        check(all(item['_tag'] == 'Event' and item['event']['payload'] == {'count': 1} for item in batch),
              'bounded event payload')
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
        wire.watch(replies, batches[replies][-1]['cursor'])
        wire.receive(1.2, quiet=True)
    final_state = inventory(private)
    check(all(entry in final_state for entry in original), 'legacy user state preserved')
    return dict(distinctSubjects=len(distinct), conversationEvents=len(batches[conversation]),
                repliesEvents=len(batches[replies]), exactReplays=2, preservedLegacyFiles=len(original))


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
