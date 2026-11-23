"""Exercise official refresh with two CLI builds and their matching official Slack archives.

Usage: python3 -B refresh_validation.py OLD_CLI OLD_ARCHIVE NEW_CLI NEW_ARCHIVE
Both daemons run in the same disposable home. No network or Slack account is needed.
"""
from contextlib import contextmanager
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'direct'))
from test_source import database, fixture


def until(probe):
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        if value := probe():
            return value
        time.sleep(0.2)
    raise AssertionError(f'timed out waiting for {probe.__name__}')


def exercise(root, old_cli, old_archive, new_cli, new_archive):
    release = root / 'archives'
    release.mkdir()
    for archive in (old_archive, new_archive):
        shutil.copyfile(archive, release / archive.name)
    tools = root / 'bin'
    tools.mkdir()
    for name in ('launchctl', 'systemctl', 'security', 'secret-tool', 'osascript', 'notify-send'):
        stub = tools / name
        stub.write_text('#!/bin/sh\nexit 1\n')
        stub.chmod(0o700)
    wake = tools / 'capture'
    wake.write_text('#!/bin/sh\ncat >> "$HOME/wake"\n')
    wake.chmod(0o700)
    env = dict(HOME=str(root), PATH=str(tools) + os.pathsep + os.environ['PATH'],
               EXANGELOS_HOME=str(root / 'state'), HTTPS_PROXY='http://127.0.0.1:9',
               HTTP_PROXY='http://127.0.0.1:9')
    cache = root / 'cache'
    cache.mkdir()
    channel = 'D0000002'
    state = fixture()
    state['messages'][channel] = {}
    database(cache, state)

    @contextmanager
    def daemon(binary):
        p = subprocess.Popen([binary, 'daemon'], env=env, stdout=subprocess.DEVNULL)

        def cli(*args, required=True):
            r = subprocess.run([binary, '--json', *args], env=env, capture_output=True, timeout=10)
            if required:
                assert r.returncode == 0, (r.stderr or r.stdout).decode()
            return json.loads(r.stdout) if r.returncode == 0 else None
        try:
            until(lambda: (root / 'state/daemon.sock').is_socket() and p.poll() is None)
            yield cli
        finally:
            p.terminate()
            p.wait(timeout=15)

    def version(cli):
        return next((c['version'] for c in cli('connectors') if c['name'] == 'slack'), None)

    with daemon(old_cli) as cli:
        cli('settings', 'set', 'officialConnectorFolder=' + str(release))
        cli('settings', 'set', 'limits.wakeWindow=0 millis')
        cli('settings', 'harness', 'set', 'capture', '--', str(wake), '{session}')
        cli('subscribe', 'slack', channel, '--intent', 'Install fixture', '--pull-only', required=False)
        assert old_archive.name == f'slack-{version(cli)}.tar.gz'
        cli('connector', 'configure', 'slack', 'subscriptionAccess=persisted-cache',
            'messagePreviews=enabled', 'pollIntervalMs=1000', 'cacheRoot=' + str(cache))

    with daemon(new_cli) as cli:
        until(lambda: new_archive.name == f'slack-{version(cli)}.tar.gz')
        watch = cli('subscribe', 'slack', channel, '--intent', 'Observe fixture', '--target', 'capture:fixture')
        until(lambda: cli('show', watch['id'])['subscription'].get('cursor'))
        ts = f'{time.time_ns() // 1000:016d}'
        ts = ts[:-6] + '.' + ts[-6:]
        message = dict(type='message', ts=ts, text='Synthetic delivery', _rxn_key=f'message-{ts}-{channel}')
        state['messages'][channel][ts] = message
        database(cache, state, sequence=30)
        event, = until(lambda: cli('events', watch['id']))
        assert event['payload']['preview'] == message['text']
        rendered = until(lambda: (root / 'wake').exists() and (root / 'wake').read_text())
        assert event['summary'] in rendered and message['text'] in rendered


if __name__ == '__main__':
    with tempfile.TemporaryDirectory(prefix='slack-refresh-', dir='/tmp') as disposable:
        exercise(Path(disposable).resolve(), *(Path(arg).resolve(strict=True) for arg in sys.argv[1:]))
    print('Official refresh retained preview consent in the installed payload and wake.')
