import contextlib
import ctypes
import json
import logging
import os
from pathlib import Path
import re
import stat
import struct
import sys

from pin_store import locked, optional, private_directory, read_json, save_json, unique_object
import observation
import scan

MAX_INPUT = 65536
MAX_FILES = 10000
MAX_MESSAGES = 10000


class PinnedScopeChanged(ValueError):
    pass


def scope_token(key, selection, epoch):
    if 'message' in selection:
        return observation.token(key, 'selected-message-scope-v1', selection['workspace'], selection['owner'],
                                 sorted(selection['conversations']), selection.get('thread'), selection['message'],
                                 selection.get('parentHint'), epoch)
    return observation.token(key, 'selected-scope-v2', selection['workspace'], selection['owner'],
                             sorted(selection['conversations']), selection.get('thread'), epoch)


def subscription_identity(secret, epoch, selection):
    key = observation.token(secret, 'subscription-key-v2', epoch['root'], selection['workspace'],
                            selection['owner'], selection['conversations'][0], selection.get('thread'))
    if 'message' in selection:
        key = observation.token(secret, 'message-selection-v1', key, selection['message'], selection.get('parentHint'))
    return key, scope_token(bytes.fromhex(key), selection, epoch)


def reference_binding(directory, secret, epoch, selection, timestamp, parent=None):
    name = observation.token(secret, 'message-parent-v1', epoch, selection['workspace'],
                             selection['owner'], selection['conversations'][0], timestamp)
    path = directory / ('reference-' + name + '.json')
    saved = optional(path)
    if saved is not None and (not isinstance(saved, str) or not re.fullmatch(observation.TIMESTAMP, saved)):
        raise ValueError('saved message parent')
    if saved is None and parent:
        save_json(path, parent)
        return parent
    return saved


def acquire(request):
    if not isinstance(request, dict) or set(request) - {'selection', 'key', 'root', 'expectedScope', 'includePreview', 'volumeIdentity'}:
        raise ValueError('request')
    include_preview = request.get('includePreview', False)
    if type(include_preview) is not bool:
        raise ValueError('request')
    selection = request.get('selection')
    if not isinstance(selection, dict) or not {'workspace','owner','conversations'} <= selection.keys() or selection.keys() - {
            'workspace','owner','conversations','thread','message','parentHint'}:
        raise ValueError('selection')
    workspace, owner = selection['workspace'], selection['owner']
    conversations = selection['conversations']
    if not isinstance(workspace, str) or not re.fullmatch(r'T[A-Z0-9]{6,30}', workspace):
        raise ValueError('selection')
    if not isinstance(owner, str) or not re.fullmatch(r'[UW][A-Z0-9]{6,30}', owner):
        raise ValueError('selection')
    if not isinstance(conversations, list) or not 1 <= len(conversations) <= 1000:
        raise ValueError('selection')
    if any(not isinstance(c, str) or not re.fullmatch(r'[CDG][A-Z0-9]{6,30}', c) for c in conversations):
        raise ValueError('selection')
    thread = selection.get('thread')
    if 'thread' in selection and (len(conversations) != 1 or not isinstance(thread, str)
                                   or not re.fullmatch(observation.TIMESTAMP, thread)):
        raise ValueError('selection')
    message_ref = selection.get('message')
    hint = selection.get('parentHint')
    if 'message' in selection and (len(conversations) != 1 or not isinstance(message_ref,str)
                                   or not re.fullmatch(observation.TIMESTAMP,message_ref)
                                   or (thread and thread != (hint or message_ref))
                                   or not (thread or hint) or not request.get('expectedScope')):
        raise ValueError('message selection')
    if 'parentHint' in selection and not (message_ref and isinstance(hint, str) and re.fullmatch(observation.TIMESTAMP, hint)):
        raise ValueError('parent hint')
    if len(set(conversations)) != len(conversations):
        raise ValueError('selection')
    key = request.get('key')
    if not isinstance(key, str) or not re.fullmatch(r'[a-fA-F0-9]{64}', key):
        raise ValueError('key')
    key = bytes.fromhex(key)
    root = Path(request.get('root', str(Path.home() / 'Library/Application Support/Slack/IndexedDB')))
    if root.is_symlink():
        raise ValueError('symlink')
    root = root.resolve(strict=True)
    binding = request.get('volumeIdentity')
    before, epoch = inventory(root, binding)
    scope = scope_token(key, selection, epoch)
    if 'expectedScope' in request and request['expectedScope'] != scope:
        raise PinnedScopeChanged('scope')
    candidates = []
    def collect(state, generation):
        if observation.scope(state) == (workspace, owner):
            candidates.append((state, generation))
    result = scan.run(root, observe=collect, layout_channels=conversations, file_names=include_preview)
    after, after_epoch = inventory(root, binding)
    if before != after or epoch != after_epoch or result['files_changed'] or not result['current_unchanged']:
        raise ValueError('mutation')
    if result['external_rejections'] or len(candidates) != 1:
        raise ValueError('unavailable')
    state, generation = candidates[0]
    if type(generation) is not int or not 0 < generation < 2**56:
        raise ValueError('generation')
    containers = state.get('messages')
    channels = state.get('channels', {})
    if not isinstance(containers, dict) or not isinstance(channels, dict):
        raise ValueError('incomplete')
    resolved = None
    if message_ref:
        directory = private_directory()
        binding_path = directory / ('thread-'+scope+'.json')
        resolved = optional(binding_path)
        rows = containers.get(conversations[0], {})
        if not isinstance(rows, dict):
            raise ValueError('messages')
        observed = None
        if message_ref in rows:
            observed = observation.containing_thread(rows[message_ref], message_ref, workspace, conversations[0])
        if not observed and not resolved:
            secret = bytes.fromhex(read_json(directory / 'subscriptions-key.json'))
            observed = reference_binding(directory, secret, epoch, selection, message_ref)
        if resolved is not None and not (isinstance(resolved,str) and re.fullmatch(observation.TIMESTAMP,resolved)):
            raise ValueError('saved thread')
        if observed and ((resolved and resolved != observed) or (hint and observed != hint)):
            return {'scope':scope, 'threadMismatch':True, 'complete':True, 'messages':[],
                    'generation':str(generation), 'snapshot':observation.token(key,'thread-mismatch')}
        if (not thread or (hint and hint != message_ref)) and not (resolved or observed):
            return {'scope':scope, 'missing':True, 'complete':True, 'messages':[],
                    'generation':str(generation), 'snapshot':observation.token(key,'missing-thread')}
        parent = resolved or observed or hint or message_ref
        if thread:
            thread = parent
    visible = False
    messages = []
    for conversation in sorted(conversations):
        observation.conversation_label(state, workspace, conversation)
        if conversation not in containers:
            visible |= thread is None and conversation in channels
            continue
        rows = containers[conversation]
        if not isinstance(rows, dict):
            raise ValueError('incomplete')
        visible |= thread is None or thread in rows
        selected = observation.snapshot(state, (workspace, owner, conversation), key, require_reactions=False, thread_root=thread,
                                        include_preview=include_preview)
        if not selected['complete']:
            raise ValueError('incomplete')
        messages.extend(selected['messages'])
        visible |= bool(selected['messages'])
        if len(messages) > MAX_MESSAGES:
            raise ValueError('limit')
    if message_ref and visible:
        with locked(directory):
            saved = optional(binding_path)
            if saved and saved != parent:
                raise ValueError('thread changed')
            secret = bytes.fromhex(read_json(directory / 'subscriptions-key.json'))
            if not saved:
                if (reference_binding(directory, secret, epoch, selection, message_ref, parent) != parent
                        or reference_binding(directory, secret, epoch, selection, parent, parent) != parent):
                    return {'scope':scope, 'threadMismatch':True, 'complete':True, 'messages':[],
                            'generation':str(generation), 'snapshot':observation.token(key,'thread-mismatch')}
                save_json(binding_path, parent)
            if thread:
                canonical = {k:v for k,v in selection.items() if k not in ('message','parentHint')}
                canonical['thread'] = thread
                _, handle = subscription_identity(secret, epoch, canonical)
                alias = directory / ('thread-alias-'+handle+'.json')
                if not alias.exists():
                    save_json(alias, scope)
        resolved = parent
    messages.sort(key=lambda message: message['id'])
    marker_rows = []
    for message in messages:
        marker = {k: v for k, v in message.items() if k not in (
            'preview', 'memberSender', 'memberPeer', 'edited', 'fileShare', 'fileUnavailable', 'legacyBody', 'legacySpaceBody')}
        marker['body'] = message.get('legacyBody', message['body'])
        marker_rows.append(marker)
    return {'scope': scope, **({'resolvedThread':resolved} if resolved else {}), **({} if visible else {'missing': True}), 'complete': True, 'messages': messages, 'generation': str(generation),
            'emptyBody': observation.token(key, 'body', '', None),
            'snapshot': observation.token(key, 'selected-snapshot-v1', scope, marker_rows)}


class VolumeIdentityUnavailable(ValueError):
    pass


def volume_uuid(fd):
    # Darwin sys/attr.h: five attribute groups, ATTR_VOL_INFO | ATTR_VOL_UUID.
    attrs = struct.pack('=HHIIIII', 5, 0, 0, 0x80040000, 0, 0, 0)
    result = ctypes.create_string_buffer(20)
    libc = ctypes.CDLL(None, use_errno=True)
    if not hasattr(libc, 'fgetattrlist') or libc.fgetattrlist(fd, attrs, result, len(result), 0) != 0:
        raise VolumeIdentityUnavailable('volume identity unavailable')
    size, uuid = struct.unpack('=I16s', result.raw)
    if size != len(result) or not any(uuid):
        raise VolumeIdentityUnavailable('volume identity unavailable')
    return uuid.hex()


def directory_identity(directory, binding=None, part='root', *, verified_legacy=None):
    fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        birth = getattr(info, 'st_birthtime', None)
        device = info.st_dev
        if verified_legacy is not None and [device, info.st_ino, birth] != verified_legacy:
            raise PinnedScopeChanged('scope')
        if binding is not None:
            uuid = volume_uuid(fd)
            if binding['kind'] == 'legacy':
                expected, device = binding[part]
                if uuid != expected:
                    raise PinnedScopeChanged('scope')
            elif binding['kind'] == 'volume':
                device = uuid
            else:
                raise ValueError('identity')
        return [device, info.st_ino, birth]
    finally:
        os.close(fd)


def directory_epoch(root, binding=None):
    folder = root / 'https_app.slack.com_0.indexeddb.leveldb'
    return {'root': directory_identity(root, binding), 'database': directory_identity(folder, binding, 'database')}


def inventory(root, binding=None):
    entries = {}
    total_bytes = 0
    folder = root / 'https_app.slack.com_0.indexeddb.leveldb'
    for parent in (root, *root.parents):
        if parent.is_symlink():
            raise ValueError('symlink')
    epoch = directory_epoch(root, binding)
    for base in (folder, root / 'https_app.slack.com_0.indexeddb.blob'):
        pending = [base]
        while pending:
            path = pending.pop()
            info = path.lstat()
            if not (stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode)):
                raise ValueError('file')
            if stat.S_ISREG(info.st_mode):
                total_bytes += info.st_size
                if total_bytes > 256 * 1024 * 1024:
                    raise ValueError('limit')
            entries[str(path.relative_to(root))] = (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)
            if len(entries) > MAX_FILES:
                raise ValueError('limit')
            if stat.S_ISDIR(info.st_mode):
                with os.scandir(path) as children:
                    for child in children:
                        if len(pending) + len(entries) >= MAX_FILES:
                            raise ValueError('limit')
                        if path == folder and not re.fullmatch(r'CURRENT|MANIFEST-[0-9]+|[0-9]+\.(log|ldb|sst)', child.name):
                            continue
                        pending.append(Path(child.path))
            elif info.st_size > 32 * 1024 * 1024:
                raise ValueError('limit')
            elif path.parent == folder and (path.suffix == '.log' or path.name.startswith('MANIFEST-')):
                validate_log(path)
    return entries, epoch


def validate_log(path):
    with path.open('rb') as handle:
        while block := handle.read(32768):
            offset = 0
            while len(block) - offset >= 7:
                crc, size, kind = struct.unpack_from('<IHB', block, offset)
                if not any(block[offset:]):
                    break
                end = offset + 7 + size
                if kind not in (1, 2, 3, 4) or end > len(block):
                    raise ValueError('log')
                if not scan.ldb.check_masked_crc(crc, bytes([kind]) + block[offset + 7:end]):
                    raise ValueError('checksum')
                offset = end
            if any(block[offset:]) and len(block) - offset < 7:
                raise ValueError('log')


def main():
    logging.disable(logging.CRITICAL)
    try:
        with open(os.devnull, 'w') as sink, contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink):
            raw = sys.stdin.buffer.read(MAX_INPUT + 1)
            if len(raw) > MAX_INPUT:
                raise ValueError('limit')
            result = acquire(json.loads(raw, object_pairs_hook=unique_object))
            output = json.dumps(result, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode('utf-8')
            if len(output) > 8 * 1024 * 1024:
                raise ValueError('limit')
    except PinnedScopeChanged:
        return 24
    except (FileNotFoundError, PermissionError):
        return 21
    except BaseException:
        sys.stderr.write('Slack persisted source unavailable.\n')
        return 1
    sys.stdout.buffer.write(output + b'\n')
    return 0


if __name__ == '__main__':
    sys.exit(main())
