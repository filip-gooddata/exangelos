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
        env.update(FIXTURE_API_TOKEN='fictional-installed-secret', FIXTURE_BOUNDARY_TOKEN='*fictional-boundary*',
                   FIXTURE_LABEL_SECRET='left-*alpha*-right', FIXTURE_PADDED_SECRET='left right',
                   HOME=str(home), EXANGELOS_HOME=str(home / 'state'), XDG_DATA_HOME=str(home / 'xdg'),
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

    def watch(self, selection, cursor=None, event_types=()):
        payload = dict(parameters={'selection': selection}, eventTypes=list(event_types))
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
        summary += ' | Untrusted message excerpt: ' + json.dumps(preview, ensure_ascii=False)
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


def app_posts():
    def section(value):
        return dict(type='section', text=dict(type='mrkdwn', text=value))

    jira = [section('<https://example.invalid/issues/42|FIX-42> moved to Ready')]
    context = dict(type='context', elements=[dict(type='image', image_url='https://example.invalid/icon',
                                                  alt_text='fixture icon'),
                                             dict(type='plain_text', text='Fixture board')])
    github = dict(type='rich_text', elements=[dict(type='rich_text_section', elements=[
        dict(type='text', text='Merged '),
        dict(type='link', url='https://example.invalid/pulls/42', text='pull request 42')])])
    opaque_label = deepcopy(github)
    opaque_label['elements'][0]['elements'][1]['text'] = 'a' * 40
    attachment = dict(title='Fixture pull request', title_link='https://example.invalid/pulls/42')
    return [
        ('Fixture Jira', dict(blocks=jira), 'FIX-42 moved to Ready'),
        ('Fixture Jira', dict(blocks=[section('Read <example.invalid/private|Fixture label>')]), 'Read Fixture label'),
        ('Fixture GitHub', dict(attachments=[attachment]), 'Fixture pull request'),
        ('Fixture GitHub', dict(attachments=[dict(blocks=[github])]), 'Merged pull request 42'),
        ('Fixture GitHub', dict(text='<https://example.invalid/job|job> '+'a'*40, blocks=[opaque_label]), 'Merged '+'a'*40),
        ('Fixture Jira', dict(blocks=[*jira, context]), 'FIX-42 moved to Ready Fixture board'),
        ('Fixture Jira', dict(text='<https://example.invalid/issues/42|FIX-42> updated', blocks=jira,
                             attachments=[attachment]), 'FIX-42 moved to Ready Fixture pull request'),
        ('Fixture GitHub', dict(blocks=[section('Build passed')], attachments=[attachment]),
         'Build passed Fixture pull request'),
        ('Fixture Jira', dict(text='Credential rotation', blocks=[section('Rotate <https://example.invalid/guide|credentials>'), context]), 'Rotate credentials Fixture board'),
        ('Fixture GitHub', dict(attachments=[attachment], blocks=[section('password removed')]), 'password removed Fixture pull request'),
        ('Fixture GitHub', dict(text='Build passed', attachments=[dict(attachment, fallback='secret removed')]), 'Fixture pull request'),
        ('Fixture Jira', dict(text='Status fictional-installed-secret ready'), 'Status [redacted] ready'),
        ('Fixture Jira', dict(blocks=[section('*Ready* _for_ ~draft~ <https://example.invalid/42|*FIX-42*>')]),
         'Ready for draft FIX-42'),
        ('Fixture GitHub', dict(text='Check `*keep*` build_id_v2, 3 * 4 and https://example.invalid/a_b_c'),
         'Check `*keep*` build_id_v2, 3 * 4 and https://example.invalid/a_b_c'),
        ('Fixture Jira', dict(blocks=[dict(type='section', text=dict(type='plain_text', text='*Ready* _for_ ~draft~'))]),
         '*Ready* _for_ ~draft~'),
        ('Fixture GitHub', dict(blocks=[section('Before *fictional-boundary* after')]), 'Before [redacted] after'),
        ('Fixture Jira', dict(blocks=[section('*fictional-installed-secret* ready')]), '[redacted] ready'),
        ('Fixture Jira', dict(blocks=[section('Before fictional-*installed*-secret after')]), 'Before [redacted] after'),
        ('Fixture Jira', dict(blocks=[section('left-<https://example.invalid|*alpha*>-right')]), '[redacted]'),
        ('Fixture Jira', dict(blocks=[section('*Read https://example.invalid/a_b*')]), 'Read https://example.invalid/a_b'),
        ('Fixture Jira', dict(blocks=[section('*https://example.invalid/a_b*.')]), 'https://example.invalid/a_b.'),
        ('Fixture Jira', dict(blocks=[section('*see https://example.invalid/* then done*')]),
         'see https://example.invalid/* then done'),
        ('Fixture Jira', dict(blocks=[dict(type='section', fields=[
            dict(type='plain_text', text='left '), dict(type='plain_text', text='right')])]), '[redacted]'),
        ('Fixture Jira', dict(blocks=[section('*Read https://example.invalid/first*. Then see https://example.invalid/*')]),
         'Read https://example.invalid/first. Then see https://example.invalid/*'),
        ('Fixture Jira', dict(blocks=[section('*Ready*'), section('Ready')]), 'Ready'),
        ('Fixture Jira', dict(text='🌻' * 200), '🌻' * 160),
        ('Fixture Jira', dict(redacted=True, blocks=jira), None),
        ('Fixture GitHub', dict(deleted=True, attachments=[attachment]), None),
        ('Fixture GitHub', dict(text='<https://example.invalid/builds/42|' + 'a' * 40 + '>',
                               attachments=[attachment]), 'Fixture pull request'),
        ('Fixture Jira', dict(blocks=[section('<https://example.invalid/issues/42>')]), 'https://example.invalid/issues/42'),
        ('Fixture GitHub', dict(blocks=[dict(type='actions', elements=[
            dict(type='button', action_id='internal-action', value='internal-value')])]), None),
    ]


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
    del messages[other]['text']
    messages[other].update(subtype='bot_message', attachments=[dict(title='Baseline attachment')])
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
    add(new_reply, TIME)
    add(new)
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
    order = [(TIME, 'message.edited'), (TIME, 'reaction.added'), (TIME, 'reaction.removed'),
             (new, 'message.new'), (new_reply, 'thread.reply')]
    check([(i['event']['payload']['messageTs'], i['event']['type']) for i in enabled] == order,
          'message-time order with stable edit and reaction transitions')
    check(resume(conversation, 'disabled') == enabled, 'mixed batch replays in its committed order')
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
    cursors[conversation] = disabled[-1]['cursor']
    cases = app_posts()
    expected_apps = {}

    def add_app(ts, sender, fields):
        messages[ts] = dict(ts=ts, type='message', text='', bot_id='B0000001', username=sender,
                            subtype='bot_message', _rxn_key=f'message-{ts}-{CHANNEL}')
        messages[ts].update(fields)

    # Consecutive nanoseconds straddle an hour and collapse into ties under float conversion.
    next_hour = (int(time.time()) // 3600 + 1) * 3600 * 10**6
    ordered_ts = []
    for index in range(len(cases)):
        seconds, fraction = divmod(next_hour * 1000 + index - len(cases) // 2, 10**9)
        ordered_ts.append(f'{seconds}.{fraction:09d}')
    for index in reversed(range(len(cases))):
        sender, fields, preview = cases[index]
        ts = ordered_ts[index]
        add_app(ts, sender, fields)
        if index == 0:
            del messages[ts]['text']
        elif index == 2:
            messages[ts]['text'] = b'_'  # V8 undefined with a visible attachment
        expected_apps[ts] = (sender, preview)
    first_app_ts = min(expected_apps)
    hidden_ts = timestamp(next_hour + len(cases))
    add_app(hidden_ts, 'Fixture Jira', dict(cases[0][1], hidden=True))
    database(app, state, sequence=61)
    with Wire(installed, home) as wire:
        wire.configure(dict(config, messagePreviews='enabled'))
        failed_watch(wire, conversation, cursors[conversation])
    del messages[hidden_ts]
    database(app, state, sequence=62)
    app_batch = resume(conversation, 'enabled')
    check([item['event']['payload']['messageTs'] for item in app_batch] == ordered_ts,
          'visible app posts delivered in exact cross-hour nanosecond order')
    for item in app_batch:
        event = item['event']
        ts = event['payload']['messageTs']
        sender, preview = expected_apps.pop(ts)
        link = f'https://app.slack.com/client/{SELECTION[0]}/{CHANNEL}?message_ts={ts}'
        payload = dict(version=1, count=1, messageTs=ts, sender=sender,
                       conversationLabel='Slack #fixture', permalink=link)
        if preview is not None:
            payload['preview'] = preview
        check(event['type'] == 'message.new' and event['payload'] == payload,
              f'installed app payload for {sender} at {ts}: {event["payload"]!r}')
        check_wake(event, conversation, home, f'New message by "{sender}" in "Slack #fixture"', preview)
    check(not expected_apps and resume(conversation, 'disabled') == app_batch, 'immutable app delivery replay')
    cursors[conversation] = app_batch[-1]['cursor']

    ts = current_timestamp()
    messages[first_app_ts]['blocks'] = [dict(type='header', text=dict(type='plain_text', text='New heading'))]
    add_app(ts, 'Fixture Jira', cases[0][1])
    del messages[ts]['text']
    database(app, state, sequence=66)
    opt_out = resume(conversation, 'disabled')
    check(len(opt_out) == 1 and opt_out[0]['event']['payload']['messageTs'] == ts, 'new app delivery after opt-out')
    check_wake(opt_out[0]['event'], conversation, home, 'New message by "Fixture Jira" in "Slack #fixture"')
    cursors[conversation] = opt_out[-1]['cursor']
    messages[first_app_ts]['edited'] = dict(ts=current_timestamp())
    database(app, state, sequence=67)
    edited_layout = resume(conversation, 'enabled')
    check(len(edited_layout) == 1 and edited_layout[0]['event']['type'] == 'message.edited' and
          edited_layout[0]['event']['payload']['messageTs'] == first_app_ts, 'layout-only app edit identity')
    check_wake(edited_layout[0]['event'], conversation, home,
               'Message edited (message author: "Fixture Jira") in "Slack #fixture"', 'New heading')
    check(resume(conversation, 'disabled') == edited_layout, 'layout-only edit replays its committed excerpt')
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
                repliesEvents=len(batches[replies]), exactReplays=2, appDeliveries=len(cases) + 1,
                renderedWakeChecks=len((home.parent / 'rendered-wakes.jsonl').read_text().splitlines()), legacyV1Replays=1, legacyPayloadReplays=1, preservedLegacyFiles=len(original))


def notification_delivery(installed, home):
    from test_direct import CHANNEL, SELECTION, fixture
    from test_source import database

    root = home / 'profile/IndexedDB'
    root.mkdir(parents=True)
    log = root.parent / 'logs/default/browser.log'
    log.parent.mkdir(parents=True)
    log.touch()
    state = fixture()
    database(root, state)
    base = dict(subscriptionAccess='persisted-cache', cacheRoot=str(root), pollIntervalMs='1000')
    allowed = dict(base, notificationLog='enabled', messagePreviews='enabled')

    def stamp():
        seconds, fraction = divmod(time.time_ns() // 1000, 1000000)
        return f'{seconds}.{fraction:06d}'

    def record(ts, **overrides):
        team, owner, channel = SELECTION
        data = dict(id=f'{team}|msg|{channel}|{ts}', teamId=team, userId=owner,
                    channel=channel, msg=ts, authorName='[REDACTED]', body='synthetic notification')
        data.update(overrides)
        return ('[11/24/26, 12:00:00:000] info: Store: NEW_NOTIFICATION \n'
                + json.dumps(data, indent=2) + '\n').encode()

    def append(data):
        with log.open('ab') as stream:
            stream.write(data)

    def message(ts, text):
        state['messages'][CHANNEL][ts] = dict(ts=ts, text=text, type='message', _rxn_key=f'message-{ts}-{CHANNEL}')

    with Wire(installed, home) as wire:
        wire.configure(allowed)
        handle = describe(wire, CHANNEL)
        watch = wire.watch(handle)
        saved = wire.chunk(watch)[0]['cursor']
        wire.receive(0.7, quiet=True)
        ts = stamp()
        good = record(ts)
        append(record(ts, userId='U9999999') + record(ts, teamId='T9999999')
               + record(ts, channel='C9999999') + record(ts, thread_ts=ts) + good[:80])
        wire.receive(0.7, quiet=True)
        append(good[80:] + good)
        early, = wire.chunk(watch)
        payload = early['event']['payload']
        check(early['event']['type'] == 'message.new' and payload['messageTs'] == ts
              and 'sender' not in payload and 'preview' not in payload
              and payload['permalink'].endswith(f'/{CHANNEL}?message_ts={ts}'), 'verified early identity')
        check_wake(early['event'], handle, home, 'New message by unknown author in "Slack conversation ' + CHANNEL + '"')
        wire.receive(0.7, quiet=True)

    message(ts, 'fuller cache text')
    database(root, state, sequence=20)
    with Wire(installed, home) as wire:
        wire.configure(allowed)
        watch = wire.watch(handle, saved)
        check(wire.chunk(watch) == [early], 'early edge replays after restart')
        message(ts, 'edit during replay')
        database(root, state, sequence=25)
        checkpoint, = wire.chunk(watch)
        check(checkpoint['_tag'] == 'Cursor', 'first cache observation reconciled after replay')
        first_edit, = wire.chunk(watch)
        check(first_edit['event']['type'] == 'message.edited' and first_edit['event']['payload']['preview'] == 'edit during replay',
              'first edit survives cache observation during replay')
        second = stamp()
        message(second, 'cache only')
        database(root, state, sequence=30)
        cached, = wire.chunk(watch)
        check(cached['event']['type'] == 'message.new' and cached['event']['payload']['messageTs'] == second,
              'same post suppressed and cache-only message delivered')
        append(record(second))
        wire.receive(0.8, quiet=True)
        message(ts, 'actually edited')
        database(root, state, sequence=50)
        edited, = wire.chunk(watch)
        check(edited['event']['type'] == 'message.edited' and edited['event']['payload']['preview'] == 'actually edited',
              'cache edit delivered after enrichment')

    with Wire(installed, home) as wire:
        wire.configure(base)
        watch = wire.watch(handle, edited['cursor'])
        check(wire.chunk(watch)[0]['_tag'] == 'Cursor', 'cache-only resume')
        append(record(stamp()))
        wire.receive(1.3, quiet=True)

    with Wire(installed, home) as wire:
        wire.configure(allowed)
        parent = next(iter(state['messages'][CHANNEL]))
        handle = describe(wire, f'{CHANNEL}:{parent}', 'replies')
        watch = wire.watch(handle, event_types=['thread.reply'])
        wire.chunk(watch)
        wire.receive(0.7, quiet=True)
        log.rename(log.with_suffix('.old'))
        wire.receive(1.1, quiet=True)
        ts = stamp()
        prefix = f'{SELECTION[0]}|msg|{CHANNEL}|{ts}|'
        other = '1600000000.000001'
        append(record(ts) + record(ts, id=prefix + other, thread_ts=other) + record(ts, id=prefix + parent, thread_ts=parent))
        rotated, = wire.chunk(watch)
        check(rotated['event']['payload']['messageTs'] == ts, 'fresh reply from replacement after missing path')
        ts = stamp()
        prefix = f'{SELECTION[0]}|msg|{CHANNEL}|{ts}|'
        wire.receive(0.7, quiet=True)
        log.write_bytes(record(ts, id=prefix + parent, thread_ts=parent))
        reply, = wire.chunk(watch)
        check(reply['event']['type'] == 'thread.reply' and reply['event']['payload']['messageTs'] == ts
              and reply['event']['payload']['permalink'].endswith('&thread_ts=' + parent),
              'rotated and truncated log binds only the selected reply thread')


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
    notification_delivery(installed, evidence / "notification-home")
    result["notificationDelivery"] = True
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
