"""Synthetic installed-archive acceptance. Run with Python 3.9+; requires bun/pnpm.

Usage: python3 connectors/slack/test/archive_validation.py /absolute/new-evidence-dir
Only committed Slack files are overlaid on the pinned packer tree. No user data.
"""
import hashlib
import json
import os
from pathlib import Path
import selectors
import shutil
import signal
import subprocess
import sys
import tarfile
import time
from unittest import mock

PACKER = '058760f81f660aecdd7c02ff257a9566092b77de'
REASON = 'Slack private configuration or persisted snapshot is unavailable or inconsistent'
REPO = Path(__file__).resolve().parents[3]
BUN = shutil.which('bun')


def check(ok, label):
    if not ok:
        raise AssertionError(label)


def command(args, cwd, log, timeout=180):
    with log.open('wb') as out:
        result = subprocess.run(args, cwd=cwd, stdout=out, stderr=subprocess.STDOUT, timeout=timeout)
    check(result.returncode == 0, 'command failed: ' + log.name)


def inventory(root):
    return [{'path': str(p.relative_to(root)), 'sha256': hashlib.sha256(p.read_bytes()).hexdigest(),
             'size': p.stat().st_size, 'mode': oct(p.stat().st_mode & 0o7777), 'mtime_ns': p.stat().st_mtime_ns}
            for p in sorted(root.rglob('*')) if p.is_file()]


class Wire:
    def __init__(self, installed, home, path=None):
        env = {k: v for k, v in os.environ.items() if not k.startswith(('PYTHON', 'EXANGELOS', 'XDG_'))}
        env.update(HOME=str(home), EXANGELOS_HOME=str(home / 'state'), XDG_DATA_HOME=str(home / 'xdg'),
                   XDG_CONFIG_HOME=str(home / 'config'), XDG_CACHE_HOME=str(home / 'cache'),
                   APPDATA=str(home / 'roaming'), LOCALAPPDATA=str(home / 'local'))
        if path is not None:
            env['PATH'] = str(path)
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
        check(answer == ({'_tag': 'Accepted'} if accepted else {'_tag': 'Rejected', 'reason': REASON}), 'configure result')

    def watch(self, cursor=None):
        payload = dict(parameters={'selection': 'selected'}, eventTypes=[])
        if cursor is not None:
            payload['cursor'] = cursor
        return self.request('Watch', payload)

    def chunk(self, identity):
        answer = self.receive()
        check(answer['_tag'] == 'Chunk' and str(answer['requestId']) == identity, 'watch chunk')
        self.send(dict(_tag='Ack', requestId=identity))
        return answer['values']


def exercise(installed, fixtures, evidence):
    sys.dont_write_bytecode = True
    sys.path.insert(0, str(fixtures / 'direct'))
    from test_source import database, request
    from test_direct import fixture, SELECTION
    before = inventory(installed)
    (evidence / 'inventory-before.json').write_text(json.dumps(before, indent=2) + '\n')
    homes = evidence / 'synthetic'
    homes.mkdir()
    cases = []
    for scenario in ('absent-app', 'missing-python', 'unconfigured-sentinel'):
        home = homes / scenario
        app = home / 'Library/Application Support/Slack/IndexedDB'
        app.mkdir(parents=True)
        sentinel = app / 'https_app.slack.com_0.indexeddb.leveldb/000002.log'
        if scenario == 'missing-python':
            database(app)
        elif scenario == 'unconfigured-sentinel':
            sentinel.parent.mkdir()
            sentinel.write_bytes(b'synthetic unread sentinel')
            os.utime(sentinel, ns=(1000000000, 1000000000))
        else:
            app.rmdir()
        empty_path = home / 'empty-path'
        empty_path.mkdir()
        with Wire(installed, home, empty_path if scenario == 'missing-python' else None) as wire:
            wire.handshake()
            check(wire.call('Describe', {'parameters': {'selection': 'selected'}})['_tag'] == 'Invalid', 'deferred describe')
            wire.receive(1.2, quiet=True)
            if scenario != 'unconfigured-sentinel':
                wire.configure({'privateSource': json.dumps(request(app))}, accepted=False)
                wire.configure({'sourceMode': 'persisted-cache', 'conversationSnippet': 'fixture body'}, accepted=False)
                wire.handshake()
                wire.receive(1.2, quiet=True)
            else:
                check(sentinel.stat().st_atime_ns == 1000000000, 'sentinel accessed')
        cases.append(scenario)
    after_startup = inventory(installed)
    (evidence / 'inventory-after-startup.json').write_text(json.dumps(after_startup, indent=2) + '\n')
    check(before == after_startup, 'startup mutated installation')
    home = homes / 'configured'
    app = home / 'app'
    app.mkdir(parents=True)
    database(app)
    config = dict(privateSource=json.dumps(request(app)), pollIntervalMs='1000')
    config_path = home / 'config.json'
    config_path.write_text(json.dumps(config))
    config_path.chmod(0o600)
    with Wire(installed, home) as wire:
        wire.handshake()
        wire.configure({}, accepted=False)
        wire.configure(json.loads(config_path.read_text()))
        check(wire.call('Describe', {'parameters': {'selection': 'selected'}})['_tag'] == 'Described', 'describe configured')
        watch = wire.watch()
        baseline = wire.chunk(watch)
        check(len(baseline) == 1 and baseline[0]['_tag'] == 'Cursor', 'silent baseline cursor')
        cursor = baseline[0]['cursor']
        wire.receive(1.2, quiet=True)
        state = fixture()
        next(iter(state['messages'][SELECTION[2]].values()))['text'] = 'synthetic changed body'
        database(app, state, sequence=30)
        changed = wire.chunk(watch)
        check(len(changed) == 1 and changed[0]['_tag'] == 'Event' and changed[0]['event']['type'] == 'message.edited', 'meaningful event')
        check(changed[0]['event']['payload'] == {'count': 1} and bool(changed[0]['cursor']), 'event and checkpoint')
    with Wire(installed, home) as wire:
        wire.configure(config)
        watch = wire.watch(cursor)
        check(wire.chunk(watch) == changed, 'durable exact replay')
    with Wire(installed, home) as wire:
        wire.configure(config)
        wire.watch(changed[0]['cursor'])
        wire.receive(2.2, quiet=True)
        wire.handshake()
    cases += ['deferred-configure-rejection-success', 'describe', 'silent-baseline', 'changed-message', 'durable-replay', 'durable-resume']
    import test_source
    setup_scopes = []
    for layout, identity in [('standard', SELECTION), ('custom', ('T0000022', 'U0000033', 'C0000044'))]:
        home = homes / ('portable-' + layout + '-different-user')
        app = home / ('Library/Application Support/Slack/IndexedDB' if layout == 'standard' else 'custom-cache')
        app.mkdir(parents=True)
        state = fixture()
        state['bootData']['user_id'] = identity[1]
        state['selfTeamIds'] = {'teamId': identity[0], 'defaultWorkspaceId': identity[0]}
        state['messages'] = {identity[2]: next(iter(state['messages'].values()))}
        state['reactions'] = {}
        for message in state['messages'][identity[2]].values():
            message['_rxn_key'] = f"message-{message['ts']}-{identity[2]}"
        with mock.patch.object(test_source, 'SELECTION', identity):
            database(app, state)
        values = dict(sourceMode='persisted-cache', conversationSnippet='fixture body', pollIntervalMs='1000')
        if layout == 'custom' or sys.platform != 'darwin':
            values['cacheRoot'] = str(app)
        with Wire(installed, home) as wire:
            wire.handshake()
            wire.configure(values)
            saved = json.loads((home / 'state/connectors/slack/setup.json').read_text())
            check(saved['request']['selection'] == dict(workspace=identity[0], owner=identity[1], conversations=[identity[2]]), 'captured setup selection')
            check(saved['request']['root'] == str(app), 'captured setup root')
            setup_scopes.append(saved['request']['key'])
            baseline = wire.chunk(wire.watch())
            check(len(baseline) == 1 and baseline[0]['_tag'] == 'Cursor', 'portable silent baseline')
            portable_cursor = baseline[0]['cursor']
            next(iter(state['messages'][identity[2]].values()))['text'] = 'portable changed body'
            with mock.patch.object(test_source, 'SELECTION', identity):
                database(app, state, sequence=30)
            changed = wire.chunk(str(wire.id))
            check(len(changed) == 1 and changed[0]['_tag'] == 'Event' and changed[0]['event']['type'] == 'message.edited', 'portable concrete event')
        with Wire(installed, home) as wire:
            wire.configure(values)
            check(json.loads((home / 'state/connectors/slack/setup.json').read_text()) == saved, 'stable private pin')
            check(wire.chunk(wire.watch(portable_cursor)) == changed, 'portable exact replay after restart')
            wire.configure(dict(values, sourceMode='unknown'), accepted=False)
            check(wire.call('Describe', {'parameters': {'selection': 'selected'}})['_tag'] == 'Invalid', 'invalid setup clears configuration')
            wire.handshake()
        cases.append('portable-' + layout + '-selection-and-replay')
    check(setup_scopes[0] != setup_scopes[1], 'different users have distinct keys')
    after = inventory(installed)
    (evidence / 'inventory-after-runtime.json').write_text(json.dumps(after, indent=2) + '\n')
    check(before == after, 'configured runtime mutated installation')
    return dict(cases=cases, installedFiles=len(before), immutable=True, effect='4.1.4')


def main():
    evidence = Path(sys.argv[1]).resolve()
    evidence.mkdir(parents=True, exist_ok=False)
    tree = evidence / 'tree'
    tree.mkdir()
    head = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=REPO, text=True).strip()
    for revision, paths, name in ((PACKER, [], 'packer'), (head, ['connectors/slack'], 'slack')):
        archive = evidence / (name + '.tar')
        with archive.open('wb') as out:
            subprocess.run(['git', 'archive', revision, *paths], cwd=REPO, stdout=out, check=True, timeout=30)
        with tarfile.open(archive) as source:
            source.extractall(tree)
    command(['pnpm', 'install', '--frozen-lockfile'], tree, evidence / 'install.log')
    version = json.loads((tree / 'connectors/slack/node_modules/effect/package.json').read_text())['version']
    check(version == '4.1.4', 'installed Effect version')
    out = evidence / 'archives'
    out.mkdir()
    runner = tree / 'packaging/validate-slack.ts'
    runner.write_text('import { Effect } from "effect"\nimport { bunSpawner } from "./src/spawner.ts"\nimport { buildConnectorArchive } from "./src/connector-archives.ts"\n'
                      'const result = await Effect.runPromise(buildConnectorArchive(process.argv[2], process.argv[3]).pipe(Effect.provide(bunSpawner)))\n'
                      'await Bun.write(process.argv[4], JSON.stringify(result))\n')
    command([BUN, str(runner), str(tree / 'connectors/slack'), str(out), str(evidence / 'packer-result.json')], tree, evidence / 'packer.log')
    packed = json.loads((evidence / 'packer-result.json').read_text())
    installed = evidence / 'installed'
    installed.mkdir()
    with tarfile.open(packed['archive']) as archive:
        archive.extractall(installed)
    manifest = json.loads((installed / 'connector.json').read_text())
    check({x['path'] for x in inventory(installed)} == {'connector.json', 'dist/main.js', *manifest['files']}, 'exact archive manifest')
    result = exercise(installed, tree / 'connectors/slack', evidence)
    result.update(packer=PACKER, connector=head, archive=packed['archive'], directoryDigest=packed['digest'],
                  archiveSha256=hashlib.sha256(Path(packed['archive']).read_bytes()).hexdigest())
    (evidence / 'result.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result))


if __name__ == '__main__':
    main()
