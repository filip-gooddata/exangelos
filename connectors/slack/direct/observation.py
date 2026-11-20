"""Private scoped comparisons of persisted snapshots, not a live Watch source."""
import hashlib
import hmac
import json
import re
import unicodedata


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


def workspace_domain(state, workspace):
    team = (state.get('teams') or {}).get(workspace) or {}
    if team.get('id', workspace) != workspace:
        return None
    domains = [row[field] for row, field in ((team, 'domain'), (state.get('bootData') or {}, 'team_domain'))
               if field in row]
    if domains and isinstance(domains[0], str) and all(domain == domains[0] for domain in domains):
        return domains[0]
    return None


# Match credential vocabulary used by the host's debug-report scrubber. Also
# suppress common standalone credentials, opaque strings, links and markup.
SENSITIVE = re.compile(
    r'token|key|secret|passw|auth|cookie|bearer|\bbasic\b|session|credential|signature|sig=|'
    r'redact|\[(?:removed|deleted|hidden)\]|[•●█]{2,}|passcode|passwd|private[ _-]*key|otp\b|webhook|xox[a-z]-|xapp-|gh[pousr]_|github_pat_|sk-|AKIA|ASIA|eyJ|'
    r'[a-z0-9_+/=-]{32,}|[0-9]{6,}|[<>`=]|://|www\.|[?&]\w+=|'
    r'@(?:channel|here|everyone)\b|&(?:lt|gt);|\b[\w-]+\.(?:[a-z]{2,})[/#?]|(?:\*{3,}|█)', re.IGNORECASE | re.ASCII)


def safe_text(value):
    return value.isprintable() and not SENSITIVE.search(unicodedata.normalize('NFKC', value))


def message_preview(message):
    if (message.get('type') != 'message' or ('subtype' in message and message['subtype'] != 'bot_message')
            or any(message.get(field, False) is not False for field in ('redacted', 'is_redacted', 'deleted', 'is_deleted', 'tombstone'))):
        return None
    value = message['text']
    if len(value) > 4096:
        return None
    # Inspect the whole value before clipping so a sensitive suffix suppresses
    # the entire preview. Fold only ordinary message layout whitespace.
    value = re.sub(r'[ \t\r\n]+', ' ', value).strip(' ')
    return value[:160] if value and safe_text(value) else None


def same_team(row, workspace):
    return all(row.get(field, workspace) == workspace for field in ('team', 'team_id', 'context_team_id'))


def safe_name(value):
    return (isinstance(value, str) and value == value.strip() and 0 < len(value) <= 80
            and safe_text(value))


def user_label(state, workspace, identity):
    if not isinstance(identity, str) or not re.fullmatch(r'[UW][A-Z0-9]{6,30}', identity):
        return None
    user = (state.get('users') or {}).get(identity) or {}
    if user.get('id', identity) == identity and same_team(user, workspace):
        profile = user.get('profile') or {}
        if not same_team(profile, workspace):
            return identity
        for name in (profile.get('display_name'), profile.get('real_name'), user.get('name')):
            if safe_name(name):
                return name
    return identity


def message_sender(state, workspace, message):
    user = user_label(state, workspace, message.get('user'))
    if user:
        return user
    bot = message.get('bot_id')
    if isinstance(bot, str) and re.fullmatch(r'B[A-Z0-9]{6,30}', bot):
        name = message.get('username')
        return name if safe_name(name) else bot
    return None


def conversation_label(state, workspace, channel):
    metadata = (state.get('channels') or {}).get(channel) or {}
    if metadata.get('id', channel) != channel or not same_team(metadata, workspace):
        raise ValueError('scope')
    if metadata.get('is_mpim') or str(metadata.get('name', '')).startswith('mpdm-'):
        return 'Slack group DM ' + channel
    if channel.startswith('D'):
        peer = metadata.get('user')
        name = user_label(state, workspace, peer)
        if name:
            return 'Slack DM with ' + name
    elif safe_name(metadata.get('name')):
        return 'Slack #' + metadata['name']
    return 'Slack conversation ' + channel


def message_permalink(domain, workspace, channel, timestamp, thread):
    if len(timestamp.partition('.')[2]) == 6 and safe_name(domain) and re.fullmatch(r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?', domain):
        link = f'https://{domain}.slack.com/archives/{channel}/p{timestamp.replace(".", "")}'
        if thread and thread != timestamp:
            link += f'?thread_ts={thread}&cid={channel}'
        return link
    link = f'https://app.slack.com/client/{workspace}/{channel}?message_ts={timestamp}'
    if thread and thread != timestamp:
        link += f'&thread_ts={thread}'
    return link


def snapshot(state, selection, key, *, require_reactions=True, thread_root=None, include_preview=False):
    """Normalize message markers and delivery context for one private conversation selection."""
    if len(key) < 32 or not isinstance(selection, tuple) or len(selection) != 3:
        raise ValueError('selection')
    workspace, owner = scope(state)
    if selection[:2] != (workspace, owner):
        raise ValueError('scope')
    channel = selection[2]
    messages = (state.get('messages') or {}).get(channel)
    if not isinstance(messages, dict):
        raise ValueError('selection')
    label = conversation_label(state, workspace, channel)
    domain = workspace_domain(state, workspace)
    result = []
    complete = True
    reactions = state.get('reactions')
    for timestamp, message in messages.items():
        if not isinstance(message, dict):
            complete = False
            continue
        if message.get('ts') != timestamp or not re.fullmatch(r'[0-9]{1,20}\.[0-9]{1,10}', timestamp):
            complete = False
            continue
        if any(message.get(field) not in (None, channel) for field in ('channel', 'channel_id')):
            complete = False
            continue
        thread = message.get('thread_ts')
        hidden = any(message.get(field, False) is not False for field in ('_hidden_stub', 'no_display', 'hidden'))
        if not require_reactions:
            if thread is not None and (not isinstance(thread, str) or not re.fullmatch(TIMESTAMP, thread)):
                raise ValueError('incomplete')
            if not same_team(message, workspace):
                raise ValueError('scope')
        if thread_root is not None:
            if hidden and thread is None and timestamp != thread_root:
                raise ValueError('incomplete')
            if thread != thread_root or timestamp == thread_root:
                continue
        if hidden or not isinstance(message.get('text'), str):
            complete = False
            continue
        if not require_reactions and 'edited' in message:
            if not isinstance(message['edited'], dict) or not isinstance(message['edited'].get('ts'), str):
                raise ValueError('incomplete')
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
        sender = message_sender(state, workspace, message)
        preview = message_preview(message) if include_preview and same_team(message, workspace) else None
        result.append({
            'messageTs': timestamp, 'conversationLabel': label,
            'permalink': message_permalink(domain, workspace, channel, timestamp, thread),
            **({'sender': sender} if sender else {}),
            **({'preview': preview} if preview else {}),
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
