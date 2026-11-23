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


# Only a labeled web link in a mrkdwn position has separable display text.
# Mentions, unlabeled targets, nested markup and control characters fail closed.
DISPLAY_LINK = re.compile(r'<https?://[A-Za-z0-9.-]+(?::[0-9]+)?(?:[/#?][^<>|\s]*)?\|([^<>|\r\n]+)>')


def display_text(value, mrkdwn=False):
    if not isinstance(value, str) or len(value) > 4096:
        raise ValueError('preview')
    if mrkdwn and any(not char.isprintable() and char not in ' \t\r\n' for char in value):
        raise ValueError('preview')
    if mrkdwn:
        def label(match):
            text = display_text(match[1])
            if not text:
                raise ValueError('preview')
            return text
        value = DISPLAY_LINK.sub(label, value)
    value = re.sub(r'[ \t\r\n]+', ' ', value).strip(' ')
    if value and (not safe_text(value) or (mrkdwn and SENSITIVE.search(
            unicodedata.normalize('NFKC', re.sub(r'[*_~]', '', value))))):
        raise ValueError('preview')
    return value


def layout_items(row, field):
    values = row.get(field, {})
    if not isinstance(values, dict) or set(values) != {str(i) for i in range(len(values))}:
        raise ValueError('preview')
    return (values[str(i)] for i in range(len(values)))


def block_text(row):
    for block in layout_items(row, 'blocks'):
        if not isinstance(block, dict):
            raise ValueError('preview')
        kind = block.get('type')
        if kind == 'rich_text':
            for section in layout_items(block, 'elements'):
                if not isinstance(section, dict) or section.get('type') != 'rich_text_section':
                    raise ValueError('preview')
                runs = []
                for run in layout_items(section, 'elements'):
                    if not isinstance(run, dict) or run.get('type') not in ('text', 'link') or not isinstance(run.get('text'), str):
                        raise ValueError('preview')
                    # Adjacent rich-text runs have no implicit whitespace.
                    if run['type'] == 'link' and not run['text'].strip():
                        raise ValueError('preview')
                    runs.append(run['text'])
                yield display_text(''.join(runs))
            continue
        if kind == 'section':
            objects = ([block['text']] if 'text' in block else []) + list(layout_items(block, 'fields'))
        elif kind == 'header':
            objects = [block.get('text')]
        elif kind == 'context':
            objects = layout_items(block, 'elements')
        elif kind == 'image' and 'title' in block:
            objects = [block['title']]
        elif kind in ('actions', 'divider', 'image'):
            continue
        else:
            raise ValueError('preview')
        for obj in objects:
            if not isinstance(obj, dict):
                raise ValueError('preview')
            if kind == 'context' and obj.get('type') == 'image':
                continue
            if obj.get('type') not in ('plain_text', 'mrkdwn') or (kind in ('header', 'image') and obj.get('type') != 'plain_text'):
                raise ValueError('preview')
            yield display_text(obj.get('text'), obj['type'] == 'mrkdwn' and kind != 'header')


def attachment_text(row):
    for attachment in layout_items(row, 'attachments'):
        if not isinstance(attachment, dict):
            raise ValueError('preview')
        if 'fallback' in attachment:
            display_text(attachment['fallback'], True)  # screen alternate notification text
        formats = list(layout_items(attachment, 'mrkdwn_in'))
        for field in ('pretext', 'title', 'text'):
            if field in attachment:
                yield display_text(attachment[field], field in ('text', 'pretext') and field in formats)
        for entry in layout_items(attachment, 'fields'):
            if not isinstance(entry, dict):
                raise ValueError('preview')
            for field in ('title', 'value'):
                if field in entry:
                    yield display_text(entry[field], field == 'value' and 'fields' in formats)
        yield from block_text(attachment)


def message_preview(message):
    if (message.get('type') != 'message' or message.get('subtype') not in (None, 'bot_message')
            or any(message.get(field, False) is not False for field in ('redacted', 'is_redacted', 'deleted', 'is_deleted', 'tombstone'))):
        return None
    app = (message.get('subtype') == 'bot_message'
           or any(isinstance(message.get(field), str) and re.fullmatch(pattern, message[field])
                  for field, pattern in (('app_id', r'A[A-Z0-9]{6,30}'), ('bot_id', r'B[A-Z0-9]{6,30}'))))
    try:
        primary = display_text(message['text'], app and message.get('mrkdwn', True) is True)
        if not app:
            return primary[:160] or None
        # Check every supported representation before choosing one or clipping.
        pieces = [part for part in (*block_text(message), *attachment_text(message)) if part]
        layout = display_text(' '.join(pieces))
    except ValueError:
        return None
    return (primary or layout)[:160] or None


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


def member_name(state, workspace, identity):
    if not isinstance(identity, str) or not re.fullmatch(r'[UW][A-Z0-9]{6,30}', identity):
        return None
    users = state.get('users') or {}
    if identity in users:
        user = users[identity]
        if not isinstance(user, dict) or user.get('id', identity) != identity or not same_team(user, workspace):
            return None
        profile = user.get('profile', {})
        if not isinstance(profile, dict) or not same_team(profile, workspace):
            return None
    member = (state.get('members') or {}).get(identity)
    if not isinstance(member, dict) or member.get('id') != identity:
        return None
    profile = member.get('profile')
    if not isinstance(profile, dict) or not all(same_team(row, workspace) for row in (member, profile)):
        return None
    if not any(row.get(field) == workspace for row in (member, profile)
               for field in ('team', 'team_id', 'context_team_id')):
        return None
    return next((value for value in (profile.get('display_name'), profile.get('real_name'), member.get('name'))
                 if safe_name(value)), None)


def message_sender(state, workspace, message):
    user = user_label(state, workspace, message.get('user'))
    if user:
        return user
    bot = message.get('bot_id')
    if isinstance(bot, str) and re.fullmatch(r'B[A-Z0-9]{6,30}', bot):
        name = message.get('username')
        return name if safe_name(name) else bot
    return None


def conversation_label(state, workspace, channel, *, include_members=False):
    metadata = (state.get('channels') or {}).get(channel) or {}
    if metadata.get('id', channel) != channel or not same_team(metadata, workspace):
        raise ValueError('scope')
    if metadata.get('is_mpim') or str(metadata.get('name', '')).startswith('mpdm-'):
        return 'Slack group DM ' + channel
    if channel.startswith('D'):
        peer = metadata.get('user')
        name = user_label(state, workspace, peer)
        if include_members and name == peer:
            name = member_name(state, workspace, peer) or name
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
    peer = ((state.get('channels') or {}).get(channel) or {}).get('user')
    peer_name = member_name(state, workspace, peer) if channel.startswith('D') and label == f'Slack DM with {peer}' else None
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
        sender_name = member_name(state, workspace, sender) if sender == message.get('user') else None
        preview = message_preview(message) if include_preview and same_team(message, workspace) else None
        result.append({
            'messageTs': timestamp, 'conversationLabel': label,
            'permalink': message_permalink(domain, workspace, channel, timestamp, thread),
            **({'sender': sender} if sender else {}),
            **({'memberSender': sender_name} if sender_name else {}),
            **({'memberPeer': peer_name} if peer_name else {}),
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
