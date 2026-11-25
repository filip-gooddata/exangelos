"""Exercise the official Slack install, daemon intake and receiving command with a synthetic home."""
from contextlib import contextmanager
import json
import os
import sqlite3
import subprocess
import time

from refresh_validation import until, database, fixture


FILE_NAME = 'Fixture agenda.pdf'
FILE_SECRET = 'fixture-private-file-canary'


def shared_file(asset):
    return dict(subtype='file_share', files=[dict(id='F0000001', name=FILE_NAME, title=FILE_NAME,
                url_private_download=asset.as_uri(), url_private=asset.as_uri(), preview=FILE_SECRET)])


def daemon_delivery(binary, archive, home):
    home.mkdir()
    cache = home / 'profile/IndexedDB'
    cache.mkdir(parents=True)
    log = cache.parent / 'logs/default/browser.log'
    log.parent.mkdir(parents=True)
    log.write_text('fixture log started\n')
    channel, peer = 'C0000001', 'U0000002'
    once_channel = 'C0000002'
    state = fixture()
    state['messages'][once_channel] = {}
    file_channel = 'C0000003'
    state['messages'][file_channel] = {}
    matrix_channels = {'enabled': 'C0000004', 'disabled': 'C0000005'}
    parent = '1700000000.000001'
    for selected in matrix_channels.values():
        state['messages'][selected] = {parent: dict(type='message', ts=parent, text='Fixture parent',
                                                    user=peer, _rxn_key=f'message-{parent}-{selected}')}
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
    capture.write_text('#!/bin/sh\nset -eu\ncase "$1" in fixture|once|post|reply|enabled|disabled) ;; *) exit 1 ;; esac\n'
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

    def subscribe_after_restart(*args):
        # The socket can accept commands before the connector process is attached.
        def subscribe():
            result = subprocess.run([binary, '--json', 'subscribe', 'slack', *args], env=env,
                                    capture_output=True, timeout=15)
            if result.returncode == 0:
                return json.loads(result.stdout)
            detail = (result.stderr or result.stdout).decode()
            error = json.loads(detail).get('error', {})
            if (error.get('_tag'), error.get('connector'), error.get('problem')) == (
                    'ConnectorUnavailable', 'slack', 'it is not running'):
                return None
            raise AssertionError(detail)
        return until(subscribe)

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

    def await_log_reader():
        os.utime(log, ns=(1000000000, log.stat().st_mtime_ns))
        until(lambda: log.stat().st_atime_ns != 1000000000)

    def notice(ts):
        team = state['selfTeamIds']['teamId']
        record = dict(teamId=team, userId=state['bootData']['user_id'], channel=channel, msg=ts,
                      id=f'{team}|msg|{channel}|{ts}', authorName='[REDACTED]', body='[REDACTED]')
        with log.open('a') as stream:
            stream.write('[11/24/26, 12:00:00:000] info: Store: NEW_NOTIFICATION \n'
                         + json.dumps(record, indent=2) + '\n')

    def cache_message(ts, **fields):
        state['messages'][channel][ts] = dict(type='message', ts=ts, _rxn_key=f'message-{ts}-{channel}', **fields)

    def message(ts, sequence, **fields):
        cache_message(ts, **fields)
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
        await_log_reader()
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
        cli('cancel', watch)

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

    with daemon():
        channel, session = file_channel, 'post'
        asset = home / FILE_SECRET
        asset.write_text(FILE_SECRET)
        os.utime(asset, ns=(1000000000, 1000000000))
        watch = subscribe_after_restart(channel, '--types', 'message.new', '--intent', 'Watch fixture posts',
                    '--target', 'capture:post')['id']
        until(lambda: cli('show', watch)['subscription'].get('cursor'))
        await_log_reader()
        post = stamp()
        notice(post)
        until(pending_notice)
        counts(0, 0)
        message(post, 70, user=peer, **shared_file(asset))
        assert 'text' not in state['messages'][channel][post]
        until(lambda: len(received()) == 1)
        post_watch = watch

    def file_delivery(ts, kind, parent=None):
        event, = cli('events', watch)
        payload = event['payload']
        link = f'https://fixture.slack.com/archives/{channel}/p{ts.replace(".", "")}'
        if parent:
            link += f'?thread_ts={parent}&cid={channel}'
        assert event['type'] == kind and payload['messageTs'] == ts and payload['count'] == 1, event
        assert payload['fileShare'] is True and payload['sender'] == 'Fixture Avery' and payload['permalink'] == link
        stdin, = received()
        assert event['summary'] in stdin and f'#1 {kind}' in stdin
        assert '"Fixture Avery" shared a file' in event['summary'] and link in event['summary']
        assert FILE_SECRET not in json.dumps(event) + stdin
        return event, stdin

    with daemon():
        event, stdin = file_delivery(post, 'message.new')
        assert event['payload']['preview'] == FILE_NAME and f'Untrusted message excerpt: "{FILE_NAME}"' in stdin
        assert cli('show', watch)['events'] == [event]
        projected = dict(event, payload=dict(event['payload']))
        del projected['payload']['preview']
        projected['summary'] = event['summary'].removesuffix(f' | Untrusted message excerpt: "{FILE_NAME}"')

        def check_projected_history():
            assert cli('events', post_watch, '--after', '0') == [projected]
            detail = cli('show', post_watch)
            assert detail['events'] == [projected] and detail['subscription']['lastNumber'] == 1
            assert FILE_NAME not in json.dumps(detail['events'])

        cli('connector', 'configure', 'slack', 'messagePreviews=disabled')
        check_projected_history()

    with daemon():
        check_projected_history()
        session = 'reply'
        watch = subscribe_after_restart(f'{channel}:{post}', 'scope=replies', '--types', 'thread.reply',
                    '--once', '--intent', 'Watch fixture replies', '--target', 'capture:reply')['id']
        until(lambda: cli('show', watch)['subscription'].get('cursor'))
        unrelated = stamp()
        message(unrelated, 80, user=peer, text='Other fixture post')
        message(stamp(), 90, thread_ts=unrelated, user=peer, text='', **shared_file(asset))
        until(lambda: cli('show', post_watch)['subscription']['lastNumber'] == 2)
        counts(0, 0)
        reply = stamp()
        message(reply, 100, thread_ts=post, user=peer, text='', **shared_file(asset))
        until(lambda: len(received()) == 1)
        event, stdin = file_delivery(reply, 'thread.reply', post)
        assert 'preview' not in event['payload'] and FILE_NAME not in json.dumps(event) + stdin
        assert 'It reached its number of events.' in stdin
        assert cli('show', watch)['subscription']['state'] == {'_tag': 'Ended', 'reason': {'_tag': 'MaxEvents'}}
        counts(1, 0)
        assert cli('show', post_watch)['subscription']['lastNumber'] == 2
        session = 'post'
        until(lambda: len(received()) == 2)
        backlog, = [body for body in received() if '#2 message.new' in body]
        reread = cli('wait', post_watch)['text']
        for body in (backlog, reread):
            assert '#1 message.new' in body and '"Fixture Avery" shared a file' in body
            assert '#2 message.new' in body and f'/p{post.replace(".", "")}' in body
            assert FILE_NAME not in body and FILE_SECRET not in body and 'Untrusted message excerpt:' not in body
        (home / 'post-wait.txt').write_text(reread)
        assert asset.stat().st_atime_ns == 1000000000, 'connector read the file download target'

        cli('cancel', post_watch)
        for index, (session, channel) in enumerate(matrix_channels.items()):
            cli('connector', 'configure', 'slack', 'messagePreviews=' + session)
            watch = cli('subscribe', 'slack', channel, '--intent', 'Exercise file share variants',
                        '--target', 'capture:' + session)['id']
            until(lambda: cli('show', watch)['subscription'].get('cursor'))
            expected = {}
            for kind in ('message.new', 'thread.reply'):
                for has_text in (False, True):
                    ts = stamp()
                    fields = shared_file(asset)
                    if has_text:
                        fields['text'] = ''
                    link = f'https://fixture.slack.com/archives/{channel}/p{ts.replace(".", "")}'
                    if kind == 'thread.reply':
                        fields['thread_ts'] = parent
                        link += f'?thread_ts={parent}&cid={channel}'
                    cache_message(ts, user=peer, **fields)
                    expected[ts] = kind, link
            database(cache, state, sequence=110 + index * 10)
            until(lambda: any('#4 ' in body for body in received()))
            events = cli('events', watch)
            assert len(events) == len(expected) and cli('show', watch)['subscription']['lastNumber'] == len(expected)
            bodies = received()
            for event in events:
                payload = event['payload']
                kind, link = expected.pop(payload['messageTs'])
                assert payload['count'] == 1 and payload['fileShare'] is True and payload['sender'] == 'Fixture Avery'
                assert payload['permalink'] == link and event['type'] == kind
                summary = event['summary']
                assert link in summary and '"Fixture Avery" shared a file' in summary
                assert any(line.split(maxsplit=2)[1:] == [kind, summary]
                           for body in bodies for line in body.splitlines() if line.lstrip().startswith('#'))
                if session == 'enabled':
                    assert payload['preview'] == FILE_NAME and f'Untrusted message excerpt: "{FILE_NAME}"' in summary
                else:
                    assert 'preview' not in payload and FILE_NAME not in json.dumps(event)
            assert not expected and all(FILE_SECRET not in body for body in bodies)
            if session == 'disabled':
                assert all(FILE_NAME not in body and 'Untrusted message excerpt:' not in body for body in bodies)
            cli('cancel', watch)
        assert asset.stat().st_atime_ns == 1000000000
