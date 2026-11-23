"""Current MANIFEST membership diagnostic; aggregate-only, not an atomic snapshot."""
import sys, re, io, collections, importlib.util
from pathlib import Path
import wire as acquire
import projection as redux_fields
import observation
import secrets
acquire.CAP=16*1024*1024
sys.path.insert(0, str(Path(__file__).resolve().parent / 'vendor'))
import ccl_leveldb as ldb
ldb.ccl_simplesnappy.decompress = acquire.snappy

class CheckedTable(ldb.LdbFile):
    def _read_block(self, handle):
        if handle.length > acquire.CAP or handle.offset < 0 or handle.offset + handle.length + 5 > self.path.stat().st_size:
            raise ValueError('bounds')
        if not self._block_checksum_matches(handle):
            raise ValueError('checksum')
        return super()._read_block(handle)


def run(root, consume=None, observe=None, layout_channels=()):
    folder=root/'https_app.slack.com_0.indexeddb.leveldb'
    current=folder/'CURRENT'
    if current.is_symlink() or current.stat().st_size>128: raise ValueError('current')
    raw=current.read_bytes()
    if not re.fullmatch(rb'MANIFEST-[0-9]+\n',raw):raise ValueError('current')
    manifest=folder/raw[:-1].decode('ascii')
    if manifest.is_symlink() or manifest.stat().st_size>4*1024*1024: raise ValueError('manifest')
    before=manifest.stat()
    m=ldb.ManifestFile(manifest)
    live={};log=previous=None
    try:
        for edit in m:
            for f in edit.deleted_files:live.pop(f.file_no,None)
            for f in edit.new_files:live[f.file_no]=f.file_size
            if edit.log_number is not None:log=edit.log_number
            if edit.prev_log_number is not None:previous=edit.prev_log_number
        if m.damage or log is None:raise ValueError('manifest')
    finally:m.close()
    after=manifest.stat()
    if (before.st_size,before.st_mtime_ns)!=(after.st_size,after.st_mtime_ns):raise ValueError('race')
    records=[];counts=collections.Counter();selected=0;changed=0;read_tables=set();read_logs=set()
    for path in folder.iterdir():
        match=re.fullmatch(r'([0-9]+)\.(ldb|sst|log)',path.name)
        if not match or path.is_symlink():continue
        number=int(match[1]);islog=match[2]=='log'
        if not ((islog and (number>=log or number==previous)) or (not islog and number in live)):continue
        if not islog and number in read_tables:raise ValueError('duplicate_table')
        before=path.stat()
        if before.st_size>32*1024*1024:raise ValueError('bound')
        if not islog and before.st_size!=live[number]:raise ValueError('size')
        handle=ldb.LogFile(path) if islog else CheckedTable(path)
        try:
            for r in handle:
                records.append(r)
                if len(records)>100000:raise ValueError('bound')
            if handle.damage:raise ValueError('damaged')
        finally:handle.close()
        after=path.stat();changed+=int((before.st_size,before.st_mtime_ns)!=(after.st_size,after.st_mtime_ns));selected+=1
        if not islog:read_tables.add(number)
        else:read_logs.add(number)
    if observe is not None and not ({log} | ({previous} if previous else set())) <= read_logs:raise ValueError('missing_log')
    if read_tables != set(live):raise ValueError('missing_table')
    latest=acquire.reconcile(records,counts)
    if observe is not None and counts['conflicting_latest_keys']:raise ValueError('ambiguous')
    external=linked=blob_encrypted=blob_rejected=0
    projected={}
    scoped=dict.fromkeys(("conversations", "messages", "reaction_complete_messages", "scope_rejections"),0)
    steps=dict.fromkeys(('metadata_parsed','blob_loaded','envelope_unwrapped','projected'),False)
    errors=dict.fromkeys(('metadata','wrapper','bound','type','size','symlink','race','nested','header','version','trailing','missing','other','bounds','bytes_limit','string_limit','nodes_limit','depth_limit','buffer_view','unsupported_tag','property_count','envelope','framing','truncated','array_limit','array_length','key_tag','duplicate_field','reference','array_buffer','sparse_array','map','set','host_object','date','bigint','varint','string_encoding','scope'),0)
    keys={r.user_key:r for r in latest}
    redux_dbs=set();redux_stores=set();message_stores=set()
    for record in latest:
        if record.state.value!=1:continue
        db,store,index=acquire.prefix(record.user_key)
        tag=record.user_key[0];n=1+(tag>>5)+1+((tag>>2)&7)+1+(tag&3)+1
        suffix=record.user_key[n:]
        if db==store==index==0 and suffix[:1]==b'\xc9':
            stream=io.BytesIO(suffix[1:]);origin_size=acquire.uint(stream);acquire.take(stream,origin_size*2)
            name_size=acquire.uint(stream);name=acquire.take(stream,name_size*2)
            if not stream.read(1) and name=='reduxPersistence'.encode('utf-16-be'):redux_dbs.add(int.from_bytes(record.value,'little'))
        if db and store==index==0:
            if suffix==b'\x01' and record.value=='reduxPersistence'.encode('utf-16-be'):redux_dbs.add(db)
            if suffix[:1]==b'\x32':
                stream=io.BytesIO(suffix[1:]);sid=acquire.uint(stream)
                if stream.read()==b'\x00':
                    if record.value=='reduxPersistenceStore'.encode('utf-16-be'):redux_stores.add((db,sid))
                    if record.value=='messages'.encode('utf-16-be'):message_stores.add((db,sid))
    matched_record=False
    for r in latest:
        db,store,index=acquire.prefix(r.user_key)
        if not db or not store or index!=1 or r.state.value!=1 or not r.value:continue
        if db not in redux_dbs or (db,store) not in redux_stores:continue
        matched_record=True
        if acquire.payload(r.value) is not None:
            if observe is not None:raise ValueError('inline')
            continue
        external+=1
        tag=r.user_key[0];n=1+(tag>>5)+1+((tag>>2)&7)+1+(tag&3)+1
        key=bytearray(r.user_key);index_start=n-((tag&3)+1)
        key[index_start:n]=(3).to_bytes((tag&3)+1,'little')
        metadata=keys.get(bytes(key))
        linked+=int(metadata is not None and metadata.state.value==1 and bool(metadata.value))
        try:
            if metadata is None or metadata.state.value!=1:raise ValueError('metadata')
            wrapper=io.BytesIO(r.value);acquire.uint(wrapper)
            if wrapper.read(3)!=b'\xff\x11\x01':raise ValueError('wrapper')
            size=acquire.uint(wrapper);target=acquire.uint(wrapper)
            if wrapper.read(1) or size>acquire.CAP or target>100:raise ValueError('bound')
            meta=io.BytesIO(metadata.value)
            for i in range(target+1):
                if meta.read(1)!=b'\x00':raise ValueError('type')
                number=acquire.uint(meta);mime_len=acquire.uint(meta)
                acquire.take(meta,mime_len*2);data_size=acquire.uint(meta)
            steps['metadata_parsed']=True
            if data_size!=size:raise ValueError('size')
            base=root/'https_app.slack.com_0.indexeddb.blob'
            parts=(base,base/f'{db:x}',base/f'{db:x}'/f'{number>>8:02x}',base/f'{db:x}'/f'{number>>8:02x}'/f'{number:x}')
            if any(p.is_symlink() for p in parts):raise ValueError('symlink')
            path=parts[-1];before=path.stat()
            if before.st_size!=size:raise ValueError('size')
            with path.open('rb') as f:b=f.read(acquire.CAP+1)
            after=path.stat()
            if (before.st_size,before.st_mtime_ns)!=(after.st_size,after.st_mtime_ns):raise ValueError('race')
            steps['blob_loaded']=True
            data=acquire.payload(b'\x00'+b)
            steps['envelope_unwrapped']=True
            if data is None:raise ValueError('nested')
            state=redux_fields.project(data, layout_channels)
            identity=observation.scope(state)
            record_key=io.BytesIO(r.user_key[n:])
            if record_key.read(1)!=b'\x01':raise ValueError('scope')
            text=acquire.take(record_key,acquire.uint(record_key)*2).decode('utf-16-be')
            if record_key.read(1) or not text.startswith('persist:slack-') or not text.endswith('-'+identity[0]+'-'+identity[1]):raise ValueError('scope')
            projected=redux_fields.summary(state)
            boot=state.get('bootData') or {};ids=state.get('selfTeamIds') or {}
            projected['boot_team_present']=isinstance(boot.get('team_id'),str)
            projected['boot_owner_present']=isinstance(boot.get('user_id'),str)
            projected['teamId_present']=isinstance(ids.get('teamId'),str)
            projected['defaultWorkspaceId_present']=isinstance(ids.get('defaultWorkspaceId'),str)
            projected['boot_matches_teamId']=boot.get('team_id')==ids.get('teamId')
            projected['boot_matches_defaultWorkspaceId']=boot.get('team_id')==ids.get('defaultWorkspaceId')
            private_key=secrets.token_bytes(32)
            try:
                identity=observation.scope(state)
                for conversation in state.get('messages',{}):
                    snap=observation.snapshot(state,(*identity,conversation),private_key)
                    scoped['conversations']+=1
                    scoped['messages']+=len(snap['messages'])
                    scoped['reaction_complete_messages']+=sum(m['reactionsComplete'] for m in snap['messages'])
            except ValueError:
                scoped['scope_rejections']+=1
            if consume is not None:consume(state)
            if observe is not None:observe(state, max(r.seq, metadata.seq))
            steps['projected']=True
        except Exception as e:
            blob_rejected+=1
            category=e.args[0] if isinstance(e,ValueError) and len(e.args)==1 and e.args[0] in errors else 'missing' if isinstance(e,FileNotFoundError) else 'other'
            errors[category]+=1
    return {
        'redux_databases': len(redux_dbs), 'redux_stores': len(redux_stores),
        'redux_metadata_matched': matched_record, 'named_message_stores': len(message_stores),
        'selected_files': selected, 'files_changed': changed,
        'current_unchanged': current.read_bytes() == raw,
        'latest_key_count': len(latest), 'external_wrappers': external,
        'external_metadata_linked': linked, 'external_rejections': blob_rejected,
        'external_errors': errors, 'external_steps': steps,
        'redux_projection': projected, 'scoped_projection': scoped, 'atomic_snapshot': False,
        'live_freshness_verified': False, 'watch_enabled': False
    }
if __name__ == '__main__':
    sys.exit(acquire.main(run))
