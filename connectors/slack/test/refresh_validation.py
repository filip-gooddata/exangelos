"""Exercise official refresh with two CLI builds and their matching official Slack archives.

Usage: python3 -B refresh_validation.py OLD_CLI OLD_ARCHIVE NEW_CLI NEW_ARCHIVE
Both daemons run in the same disposable home. No network or Slack account is needed.
"""
import argparse
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


def exercise(root, old_cli, old_archive, new_cli, new_archive, members, previews):
    assert old_archive.name != new_archive.name, 'two distinct official versions required'
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
    cache = root / 'profile/IndexedDB'
    cache.mkdir(parents=True)
    log = cache.parent / 'logs/default/browser.log'
    log.parent.mkdir(parents=True)
    log.touch()
    channel = 'D0000002'
    state = fixture()
    state['messages'][channel] = {}
    peer = 'U0000002'
    if members:
        state['channels'] = {channel: dict(id=channel, user=peer)}
        state['users'] = {peer: dict(id=peer, team=state['selfTeamIds']['teamId'], profile=b'_')}
        state['members'] = {peer: dict(id=peer, team=state['selfTeamIds']['teamId'],
                                      profile=dict(display_name='Example'))}
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
            'messagePreviews=' + previews, 'pollIntervalMs=1000', 'cacheRoot=' + str(cache))

        watch = cli('subscribe', 'slack', channel, '--intent', 'Observe fixture', '--target', 'capture:fixture')
        until(lambda: cli('show', watch['id'])['subscription'].get('cursor'))

    with daemon(new_cli) as cli:
        until(lambda: new_archive.name == f'slack-{version(cli)}.tar.gz')
        ts = f'{time.time_ns() // 1000:016d}'
        ts = ts[:-6] + '.' + ts[-6:]
        team = state['selfTeamIds']['teamId']
        notification = dict(teamId=team, userId=state['bootData']['user_id'], channel=channel, msg=ts,
                            id=f'{team}|msg|{channel}|{ts}')
        with log.open('a') as stream:
            stream.write('[11/24/26, 12:00:00:000] info: Store: NEW_NOTIFICATION \n'
                         + json.dumps(notification, indent=2) + '\n')
        time.sleep(1.5)
        assert not cli('events', watch['id']), 'upgrade did not opt in to notification log access'
        message = dict(type='message', ts=ts, text='Synthetic credential rotation', _rxn_key=f'message-{ts}-{channel}')
        if members:
            message.update(user=peer, subtype=b'_')
        state['messages'][channel][ts] = message
        database(cache, state, sequence=30)
        event, = until(lambda: cli('events', watch['id']))
        if previews == 'enabled':
            assert event['payload']['preview'] == message['text']
            assert 'Untrusted message excerpt: ' + json.dumps(message['text']) in event['summary']
        else:
            assert 'preview' not in event['payload'] and message['text'] not in event['summary']
        if members:
            assert event['payload']['sender'] == 'Example'
            assert event['payload']['conversationLabel'] == 'Slack DM with Example'
            assert 'by "Example" in "Slack DM with Example"' in event['summary']
        rendered = until(lambda: (root / 'wake').exists() and (root / 'wake').read_text())
        assert event['summary'] in rendered and (message['text'] in rendered) == (previews == 'enabled')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--previews', choices=('enabled', 'disabled'), default='enabled')
    parser.add_argument('--members', action='store_true', help='exercise member profiles and V8 undefined subtype')
    for name in ('old_cli', 'old_archive', 'new_cli', 'new_archive'):
        parser.add_argument(name, type=lambda arg: Path(arg).resolve(strict=True))
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix='slack-refresh-', dir='/tmp') as disposable:
        exercise(Path(disposable).resolve(), **vars(args))
    print('Official refresh retained preview consent in the installed payload and wake.')
