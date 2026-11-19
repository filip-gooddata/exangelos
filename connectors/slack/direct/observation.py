"""Private scoped comparisons of persisted snapshots, not a live Watch source."""
import hashlib
import hmac
import json
import re


TIMESTAMP = r'[0-9]{1,20}\.[0-9]{1,10}'


def token(key, kind, *values):
    return hmac.new(key, json.dumps([kind, *values], ensure_ascii=False, separators=(',', ':')).encode(), hashlib.sha256).hexdigest()


def scope(state):
    boot = state.get('bootData') or {}
    identities = state.get('selfTeamIds') or {}
    workspace_ids = [row[field] for row, field in ((identities, 'teamId'), (identities, 'defaultWorkspaceId'),
                                                    (boot, 'team_id')) if field in row]
    owner = boot.get('user_id')
    if not workspace_ids or not isinstance(owner, str) or not re.fullmatch(r'[UW][A-Z0-9]{6,30}', owner):
        raise ValueError('scope')
    workspace = workspace_ids[0]
    if (not isinstance(workspace, str) or not re.fullmatch(r'T[A-Z0-9]{6,30}', workspace)
            or any(value != workspace for value in workspace_ids)):
        raise ValueError('scope')
    return workspace, owner


def snapshot(state, selection, key, *, require_reactions=True, thread_root=None):
    """Return keyed fields only. Caller supplies one private conversation selection."""
    if len(key) < 32 or not isinstance(selection, tuple) or len(selection) != 3:
        raise ValueError('selection')
    workspace, owner = scope(state)
    if selection[:2] != (workspace, owner):
        raise ValueError('scope')
    channel = selection[2]
    messages = (state.get('messages') or {}).get(channel)
    if not isinstance(messages, dict):
        raise ValueError('selection')
    result = []
    complete = True
    reactions = state.get('reactions')
    for timestamp, message in messages.items():
        if not isinstance(message, dict) or message.get('_hidden_stub') or message.get('no_display'):
            complete = False
            continue
        if message.get('ts') != timestamp or not re.fullmatch(r'[0-9]{1,20}\.[0-9]{1,10}', timestamp):
            complete = False
            continue
        if any(message.get(field) not in (None, channel) for field in ('channel', 'channel_id')):
            complete = False
            continue
        if not isinstance(message.get('text'), str):
            complete = False
            continue
        if not require_reactions:
            thread = message.get('thread_ts')
            if thread is not None and (not isinstance(thread, str) or not re.fullmatch(r'[0-9]{1,20}\.[0-9]{1,10}', thread)):
                raise ValueError('incomplete')
            if 'team' in message and message['team'] != workspace:
                raise ValueError('scope')
            if 'edited' in message and (not isinstance(message['edited'], dict) or not isinstance(message['edited'].get('ts'), str)):
                raise ValueError('incomplete')
        if thread_root is not None and (message.get('thread_ts') != thread_root or timestamp == thread_root):
            continue
        rx_key = f'message-{timestamp}-{channel}'
        if message.get('_rxn_key') != rx_key:
            complete = False
            continue
        rows = reactions.get(rx_key) if isinstance(reactions, dict) else None
        rx_complete = isinstance(rows, dict)
        actors = []
        if rx_complete:
            for row in rows.values():
                if not isinstance(row, dict) or not isinstance(row.get('name'), str) or not isinstance(row.get('users'), dict):
                    rx_complete = False
                    continue
                users = list(row['users'].values())
                if any(not isinstance(user, str) for user in users) or row.get('count') != len(users) or len(set(users)) != len(users):
                    rx_complete = False
                    continue
                actors.extend(token(key, 'reaction', row['name'], user) for user in users)
        if len(set(actors)) != len(actors):
            rx_complete = False
        result.append({
            'id': token(key, 'message', *selection, timestamp),
            'body': token(key, 'body', message['text'], message.get('edited')),
            'reply': isinstance(message.get('thread_ts'), str) and message['thread_ts'] != timestamp,
            'reactions': sorted(actors), 'reactionsComplete': rx_complete
        })
        complete = complete and (rx_complete or not require_reactions)
    return {'scope': token(key, 'scope', *selection), 'complete': complete, 'messages': result}


def compare(before, after):
    """Aggregate final persisted differences; no event-time or delivery claim."""
    if before['scope'] != after['scope']:
        raise ValueError('scope')
    counts = dict.fromkeys(('new_messages', 'new_replies', 'body_changes', 'reactions_added', 'reactions_removed'), 0)
    known = {message['id']: message for message in before['messages']}
    for message in after['messages']:
        old = known.get(message['id'])
        if old is None:
            counts['new_replies' if message['reply'] else 'new_messages'] += 1
            continue
        counts['body_changes'] += old['body'] != message['body']
        if old['reactionsComplete'] and message['reactionsComplete']:
            counts['reactions_added'] += len(set(message['reactions']) - set(old['reactions']))
            counts['reactions_removed'] += len(set(old['reactions']) - set(message['reactions']))
    return counts
