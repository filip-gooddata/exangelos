"""Exercise the official Slack install, daemon intake and receiving command with a synthetic home."""
from contextlib import contextmanager
import json
import os
import sqlite3
import subprocess
import time

from refresh_validation import until, database, fixture


def daemon_delivery(binary, archive, home):
    home.mkdir()
    cache = home / 'profile/IndexedDB'
    cache.mkdir(parents=True)
    log = cache.parent / 'logs/default/browser.log'
    log.parent.mkdir(parents=True)
    log.touch()
    channel, peer = 'C0000001', 'U0000002'
    once_channel = 'C0000002'
    state = fixture()
    state['messages'][once_channel] = {}
    state['users'] = {peer: {'profile': {'display_name': 'Fixture Avery'}}}
    database(cache, state)
    tools = home / 'bin'
    tools.mkdir()
    (tools / 'exangelos').symlink_to(binary)
    for name in ('launchctl', 'systemctl', 'security', 'secret-tool', 'osascript', 'notify-send'):
        stub = tools / name
        stub.write_text('#!/bin/sh\nexit 1\n')
        stub.chmod(0o700)
    capture = tools / 'capture'
    capture.write_text('#!/bin/sh\nset -eu\ncase "$1" in fixture|once) ;; *) exit 1 ;; esac\n'
                       'file=$(mktemp "$HOME/$1-stdin-XXXXXX")\ncat > "$file"\nmv "$file" "$file.done"\n')
    capture.chmod(0o700)
    env = dict(HOME=str(home), PATH=str(tools) + os.pathsep + os.environ['PATH'],
               EXANGELOS_HOME=str(home / 'state'), XDG_DATA_HOME=str(home / 'xdg'),
               XDG_CONFIG_HOME=str(home / 'config'), XDG_CACHE_HOME=str(home / 'cache'),
               HTTPS_PROXY='http://127.0.0.1:9', HTTP_PROXY='http://127.0.0.1:9')

    def cli(*args, required=True):
        r = subprocess.run([binary, '--json', *args], env=env, capture_output=True, timeout=15)
        if required and r.returncode:
            raise AssertionError((r.stderr or r.stdout).decode())
        return json.loads(r.stdout) if r.returncode == 0 else None

    @contextmanager
    def daemon():
        with (home / 'daemon.log').open('ab') as output:
            p = subprocess.Popen([binary, 'daemon'], env=env, stdout=output, stderr=output)
            try:
                until(lambda: p.poll() is None and (home / 'state/daemon.sock').is_socket())
                yield
            finally:
                p.terminate()
                p.wait(timeout=15)

    def stamp():
        seconds, micros = divmod(time.time_ns() // 1000, 1000000)
        return f'{seconds}.{micros:06d}'

    def notice(ts):
        team = state['selfTeamIds']['teamId']
        record = dict(teamId=team, userId=state['bootData']['user_id'], channel=channel, msg=ts,
                      id=f'{team}|msg|{channel}|{ts}', authorName='[REDACTED]', body='[REDACTED]')
        with log.open('a') as stream:
            stream.write('[11/24/26, 12:00:00:000] info: Store: NEW_NOTIFICATION \n'
                         + json.dumps(record, indent=2) + '\n')

    def message(ts, sequence, **fields):
        state['messages'][channel][ts] = dict(type='message', ts=ts, _rxn_key=f'message-{ts}-{channel}', **fields)
        database(cache, state, sequence=sequence)

    session = 'fixture'

    def received():
        return [p.read_text() for p in home.glob(f'{session}-stdin-*.done')]

    def report_pending(label, missing):
        script = ('set -eu\ndata="${EXANGELOS_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/exangelos}"\n'
                  'exangelos --json show "$subscription" | jq -er \'.subscription.cursor\' | '
                  'python3 -B "$data/connectors/slack/direct/ledger.py" --pending')
        result = subprocess.run(['sh', '-c', script], env=dict(env, subscription=watch),
                                capture_output=True, text=True, timeout=15, check=True)
        assert json.loads(result.stdout) == [dict(delivery='arrival', awaiting=missing, messages=1)]
        (home / f'pending-{label}.json').write_text(result.stdout)

    def pending_notice():
        # The synthetic ledger confirms the log reader consumed the hint before we change the cache.
        path = home / 'state/connector-state/slack/ledger.sqlite3'
        with sqlite3.connect(f'{path.as_uri()}?mode=ro', uri=True) as db:
            return db.execute('SELECT count(*) FROM pending_details').fetchone()[0] == 1

    def counts(expected, acked):
        sub = cli('show', watch)['subscription']
        assert (sub['lastNumber'], sub['ackedThrough']) == (expected, acked), sub
        assert len(received()) == expected, received()

    def delivery(ts, preview, number):
        until(lambda: len(received()) >= number)
        event, = [e for e in cli('events', watch) if e['payload']['messageTs'] == ts]
        link = f'https://fixture.slack.com/archives/{channel}/p{ts.replace(".", "")}'
        assert event['type'] == 'message.new' and event['payload']['count'] == 1, event
        assert event['payload']['sender'] == 'Fixture Avery' and event['payload']['preview'] == preview, event
        assert event['payload']['permalink'] == link, event
        stdin, = [body for body in received() if link in body]
        assert all(s in stdin for s in ('Fixture Avery', preview, event['summary'], f'#{number} message.new')), stdin

    with daemon():
        cli('settings', 'set', 'officialConnectorFolder=' + str(archive.parent))
        cli('settings', 'set', 'limits.wakeWindow=0 millis')
        cli('settings', 'harness', 'set', 'capture', '--', str(capture), '{session}')
        cli('subscribe', 'slack', channel, '--intent', 'Install fixture', '--pull-only', required=False)
        assert any(archive.name == f'slack-{c["version"]}.tar.gz' for c in cli('connectors') if c['name'] == 'slack')
        cli('connector', 'configure', 'slack', 'subscriptionAccess=persisted-cache', 'notificationLog=enabled',
            'messagePreviews=enabled', 'pollIntervalMs=1000', 'cacheRoot=' + str(cache))
        watch = cli('subscribe', 'slack', channel, '--intent', 'Observe arrivals', '--target', 'capture:fixture')['id']
        until(lambda: cli('show', watch)['subscription'].get('cursor'))
        time.sleep(1.5)
        first = stamp()
        notice(first)
        notice(first)
        until(pending_notice)
        counts(0, 0)
        cursor = cli('show', watch)['subscription']['cursor']
        message(first, 20, text='')
        until(lambda: cli('show', watch)['subscription']['cursor'] != cursor)
        counts(0, 0)
        cursor = cli('show', watch)['subscription']['cursor']
        message(first, 25, user=peer, text='Synthetic notice-first message')
        until(lambda: cli('show', watch)['subscription']['cursor'] != cursor)
        counts(0, 0)
        assert cli('events', watch) == []
        report_pending('permalink', ['archive permalink'])

    with daemon():
        state['bootData']['team_domain'] = 'fixture'
        message(first, 30, user=peer, text='Synthetic notice-first message')
        delivery(first, 'Synthetic notice-first message', 1)
        counts(1, 0)
        cli('ack', watch, '--through', '1')
        second = stamp()
        message(second, 40, user=peer, text='Synthetic cache-first message')
        delivery(second, 'Synthetic cache-first message', 2)
        notice(second)
        time.sleep(2.5)
        counts(2, 1)

        channel, session = once_channel, 'once'
        watch = cli('subscribe', 'slack', channel, '--intent', 'Wait for one actionable message',
                    '--types', 'message.new,message.edited', '--once', '--target', 'capture:once')['id']
        until(lambda: cli('show', watch)['subscription'].get('cursor'))
        third = stamp()
        cursor = cli('show', watch)['subscription']['cursor']
        message(third, 50, text='Synthetic one-shot message')
        until(lambda: cli('show', watch)['subscription']['cursor'] != cursor)
        counts(0, 0)
        assert cli('show', watch)['subscription']['state']['_tag'] == 'Active'
        report_pending('author', ['author'])
        cursor = cli('show', watch)['subscription']['cursor']
        message(third, 55, text='Revised one-shot message')
        until(lambda: cli('show', watch)['subscription']['cursor'] != cursor)
        counts(0, 0)
        assert cli('show', watch)['subscription']['state']['_tag'] == 'Active'
        message(third, 60, user=peer, text='Revised one-shot message')
        delivery(third, 'Revised one-shot message', 1)
        counts(1, 0)
        assert cli('show', watch)['subscription']['state'] == {'_tag': 'Ended', 'reason': {'_tag': 'MaxEvents'}}
        assert 'It reached its number of events.' in received()[0]
