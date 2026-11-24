"""Private scoped comparisons of persisted snapshots, not a live Watch source."""
import hashlib
import hmac
import json
from pathlib import Path
import sys
import re
import unicodedata


# Installed bundles carry the shared renderer in dist.
connector_dir = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(connector_dir.parent / 'shared' if (connector_dir / 'package.json').is_file() else connector_dir / 'dist'))
from excerpt import finish_excerpt, mask_secrets


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


# Existing metadata policy for display names, independent of message excerpts.
SENSITIVE = re.compile(
    r'token|key|secret|passw|auth|cookie|bearer|\bbasic\b|session|credential|signature|sig=|'
    r'redact|\[(?:removed|deleted|hidden)\]|[•●█]{2,}|passcode|passwd|private[ _-]*key|otp\b|webhook|xox[a-z]-|xapp-|gh[pousr]_|github_pat_|sk-|AKIA|ASIA|eyJ|'
    r'[a-z0-9_+/=-]{32,}|[0-9]{6,}|[<>`=]|://|www\.|[?&]\w+=|'
    r'@(?:channel|here|everyone)\b|&(?:lt|gt);|\b[\w-]+\.(?:[a-z]{2,})[/#?]|(?:\*{3,}|█)', re.IGNORECASE | re.ASCII)


def safe_text(value):
    return value.isprintable() and not SENSITIVE.search(unicodedata.normalize('NFKC', value))


# Protected spans stay literal while surrounding mrkdwn delimiters are paired.
MRKDWN_TOKEN = re.compile(
    r'(?P<code>```[\s\S]*?(?:```|\Z)|`[^`\n]*`)'
    r'|(?P<entity><[^<>|]+(?:\|[^<>]*)?>)'
    r'|(?P<url>https?://[^\s<>]+)|(?P<escaped>\\[*_~])|(?P<marker>[*_~])')


def unescape_slack(text):
    return text.replace('&lt;', '<').replace('&gt;', '>').replace('&amp;', '&')


def mrkdwn_spans(value):
    parts = []
    openings = {}
    omit = []
    length = 0
    end = 0
    for match in MRKDWN_TOKEN.finditer(value):
        between = value[end:match.start()]
        if '\n' in between:
            openings.clear()
        parts.append(unescape_slack(between))
        length += len(parts[-1])
        part = match[0]
        end = match.end()
        if match['entity']:
            target, separator, caption = part[1:-1].partition('|')
            if separator:
                part, markers = mrkdwn_spans(caption)
                omit.extend(length + i for i in markers)
            elif target.startswith('!date^'):
                part = ''
            elif target.startswith(('mailto:', '!', '#', '@', 'https://', 'http://')):
                part = unescape_slack(target.removeprefix('mailto:').removeprefix('!'))
        elif match['url']:
            part = unescape_slack(part)
            tail = len(part.rstrip('.,;:!?)]}'))
            while tail and part[tail - 1] in openings:
                omit.extend((openings.pop(part[tail - 1]), length + tail - 1))
                tail -= 1
        elif match['marker']:
            before = value[match.start()-1] if match.start() else ''
            after = value[end:end+1]
            if part in openings and before and not before.isspace() and not after.isalnum() and after != part:
                omit.extend((openings.pop(part), length))
            elif after and not after.isspace() and not before.isalnum() and before != part and after != part:
                openings[part] = length
        else:
            part = unescape_slack(part)
        parts.append(part)
        length += len(part)
    parts.append(unescape_slack(value[end:]))
    return ''.join(parts), omit


def display_spans(value, mrkdwn=False):
    if not isinstance(value, str):
        return '', ()
    if not mrkdwn:
        return value, ()
    masked = mask_secrets(value)
    # A credential can include a link delimiter. Parsing its replacement
    # could turn a hidden target into visible text.
    if masked != value and '<' in value and any(value.count(c) != masked.count(c) for c in '<|>'):
        return '[redacted]', ()
    return mrkdwn_spans(masked)


def display_text(value, mrkdwn=False):
    text, omit = display_spans(value, mrkdwn)
    return mask_secrets(text, omit=omit)


def layout_items(row, field):
    values = row.get(field)
    if isinstance(values, dict):
        yield from (item for item in values.values() if isinstance(item, dict))


def text_object(obj):
    if isinstance(obj, dict) and obj.get('type') in ('plain_text', 'mrkdwn'):
        return display_spans(obj.get('text'), obj['type'] == 'mrkdwn')
    return '', ()


def rich_text(section):
    kind = section.get('type')
    if kind == 'rich_text_list':
        return ' '.join(rich_text(item) for item in layout_items(section, 'elements'))
    if kind not in ('rich_text_section', 'rich_text_quote', 'rich_text_preformatted'):
        return ''
    runs = []
    for run in layout_items(section, 'elements'):
        if run.get('type') == 'text':
            runs.append(display_text(run.get('text')))
        elif run.get('type') == 'link':
            runs.append(display_text(run.get('text') or run.get('url')))
    return ''.join(runs)


def block_text(row):
    for block in layout_items(row, 'blocks'):
        kind = block.get('type')
        if kind == 'rich_text':
            for section in layout_items(block, 'elements'):
                yield rich_text(section), ()
        elif kind == 'section':
            yield text_object(block.get('text'))
            for field in layout_items(block, 'fields'):
                yield text_object(field)
        elif kind == 'header':
            yield text_object(block.get('text'))
        elif kind == 'image':
            yield text_object(block.get('title'))
        elif kind == 'context':
            for obj in layout_items(block, 'elements'):
                yield text_object(obj)
        elif kind == 'actions':
            for action in layout_items(block, 'elements'):
                if action.get('type') == 'button':
                    yield text_object(action.get('text'))


def attachment_text(row):
    for attachment in layout_items(row, 'attachments'):
        formats = attachment.get('mrkdwn_in')
        formats = formats.values() if isinstance(formats, dict) else ()
        for field in ('pretext', 'title', 'text'):
            yield display_spans(attachment.get(field), field in formats)
        for entry in layout_items(attachment, 'fields'):
            yield display_spans(entry.get('title'))
            yield display_spans(entry.get('value'), 'fields' in formats)
        yield from block_text(attachment)


def excerpt_eligible(message):
    subtype = message.get('subtype')
    if (message.get('type') != 'message' or
            (subtype is not None and (not isinstance(subtype, str) or not subtype or subtype in
             ('message_deleted', 'tombstone', 'message_changed', 'message_replied', 'ekm_access_denied'))) or
            any(message.get(field, False) is not False for field in ('redacted', 'is_redacted', 'deleted', 'is_deleted', 'tombstone'))):
        return False
    return True


def app_message(message):
    return message.get('subtype') == 'bot_message' or (
        message.get('subtype') is None and any(
            isinstance(message.get(field), str) and re.fullmatch(pattern, message[field])
            for field, pattern in (('bot_id', r'B[A-Z0-9]{6,30}'), ('app_id', r'A[A-Z0-9]{6,30}'))))


def visible_layout(message):
    parts = []
    omit = []
    length = 0
    last = None
    for part, markers in (*block_text(message), *attachment_text(message)):
        if not part.strip():
            continue
        prefix = ' ' if parts else ''
        start = length + len(prefix)
        parts.append(prefix + part)
        length = start + len(part)
        visible = mask_secrets(part, omit=markers).strip()
        if visible == last:
            omit.extend(range(start - len(prefix), length))
        else:
            omit.extend(start + i for i in markers)
        last = visible
    return mask_secrets(''.join(parts), omit=omit)


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
        fallback = message.get('text')
        eligible = not hidden and same_team(message, workspace) and excerpt_eligible(message)
        missing_app_text = 'text' not in message and app_message(message)
        layout = visible_layout(message) if eligible and (include_preview or missing_app_text) else ''
        if missing_app_text and any(c.isprintable() and not c.isspace() for c in layout):
            # Slack's optional notification fallback uses the existing empty-text body marker.
            fallback = ''
        if hidden or not isinstance(fallback, str):
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
        preview = None
        if include_preview and eligible:
            preview = finish_excerpt(layout or display_text(fallback, message.get('mrkdwn', True) is True))
        result.append({
            'messageTs': timestamp, 'conversationLabel': label,
            'permalink': message_permalink(domain, workspace, channel, timestamp, thread),
            **({'sender': sender} if sender else {}),
            **({'memberSender': sender_name} if sender_name else {}),
            **({'memberPeer': peer_name} if peer_name else {}),
            **({'preview': preview} if preview else {}),
            'id': token(key, 'message', *selection, timestamp),
            'body': token(key, 'body', fallback, message.get('edited')),
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
