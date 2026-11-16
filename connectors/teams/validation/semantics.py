"""Private cache traversal with a fixed aggregate-only public output envelope.
One origin, reconciled user-key view required. No signed-in authority inferred.
"""
import datetime
import json
import re
import serialization as s
from probe import prefix

FIELDS = {
    'identity': frozenset(('id','messageid','clientmessageid')),
    'scope': frozenset(('conversationid','chatid','threadid','channelid','teamid')),
    'created': frozenset(('createdtime','createddatetime','composetime','originalarrivaltime','senttime','timestamp','arrivaltime')),
    'modified': frozenset(('lastmodifieddatetime','lastmodifiedtime','edittime','deletiontime','version')),
    'sender': frozenset(('from','sender','creator','senderid','creatorid')),
    'account': frozenset(('accountid','userid','userobjectid','homeaccountid','currentuserid','loggedinuserid','mri')),
    'tenant': frozenset(('tenantid','tid','tenant')),
    'body': frozenset(('content','body','messagetype','type')),
}
UUID = re.compile(r'(?<![0-9a-f])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![0-9a-f])',re.I)
COUNTERS = ('rows','decoded','invalid','unsupported','external','walk_limited','nested_objects','json_containers','json_rejected',
            'message_store_rows','message_store_decoded','message_store_key_matches','message_store_key_mismatches',
            'message_store_structural_candidates','nested_structural_candidates','db_names','db_names_with_uuid',
            'db_names_with_multiple_uuid','db_partition_groups','rows_with_partition_uuid','account_partition_matches',
            'tenant_partition_matches','sender_partition_matches','partition_pair_rows','nested_account_tenant_pairs','global_db_names','db_name_conflicts','all_store_key_matches','all_store_structural_candidates','all_store_nested_candidates','account_tenant_distinct_pairs','partition_pair_component_matches','primary_matches_nested_identity','primary_matches_scope','identity_is_epoch','scope_has_thread_shape','sparse_containers','map_containers','set_containers','message_shaped_nodes','message_shaped_with_ancestor_scope','message_shaped_with_primary_scope','scope_inherited_nodes','candidate_scope_primary_matches','candidate_scope_root_matches','candidate_identity_time_matches','candidate_scoped_identities','candidate_duplicate_scoped_identities','candidate_canonical_identities','candidate_identifier_nodes','candidate_message_identifier_nodes','candidate_client_identifier_nodes','account_first_component_rows','account_second_component_rows','tenant_first_component_rows','tenant_second_component_rows','unsupported_with_external_entry','external_with_external_entry','external_entries')

def _norm(k):
    return re.sub('[^a-z]','',k.lower()) if type(k) is str else ''

def _present(v):
    return (type(v) is str and bool(v)) or (type(v) in (int,float) and not isinstance(v,bool))


def _walk(obj, out):
    stack, seen, nodes, json_bytes = [(obj,0,False,False)], {}, 0, 0
    while stack:
        v, depth, encoded, inherited_scope = stack.pop()
        nodes += 1
        if nodes > s.MAX_NODES or depth > s.MAX_DEPTH:
            out['walk_limited'] += 1
            return
        if type(v) in (dict,list,tuple,s._SparseArray,s._Collection):
            if id(v) in seen: continue
            seen[id(v)]=v
        if type(v) is s._SparseArray:
            out['sparse_containers']+=1
            stack.append((v.properties,depth+1,encoded,inherited_scope))
        elif type(v) is s._Collection:
            out['map_containers' if v.kind=='map' else 'set_containers']+=1
            stack.extend((x,depth+1,encoded,inherited_scope) for x in v.items)
        elif type(v) is dict:
            out['nested_objects'] += depth > 0
            yield v, depth, encoded, inherited_scope
            scoped=inherited_scope or any(_norm(k) in FIELDS['scope'] and type(x) is str and bool(x) for k,x in v.items())
            stack.extend((x,depth+1,encoded,scoped) for x in v.values())
        elif type(v) in (list,tuple):
            stack.extend((x,depth+1,encoded,inherited_scope) for x in v)
        elif type(v) is str and v.lstrip()[:1] in ('{','['):
            json_bytes += len(v)
            if json_bytes > s.MAX_BYTES:
                out['walk_limited'] += 1
                return
            try:
                parsed = json.loads(v)
                if type(parsed) in (dict,list):
                    out['json_containers'] += 1
                    stack.append((parsed,depth+1,True,inherited_scope))
            except Exception:
                out['json_rejected'] += 1


def analyze(current):
    """Returns fixed counts/booleans only. Neither freshness nor authority is proven."""
    out = dict.fromkeys(COUNTERS,0)
    out.update({role+'_'+loc:0 for role in FIELDS for loc in ('top_rows','nested_rows','encoded_rows')})
    out.update(input_bounded=True,snapshot_verified=False,account_binding_proven=False,message_semantics_proven=False)
    if type(current) is not dict or len(current)>s.MAX_ROWS:
        out['input_bounded']=False; return out
    total=0
    for k,v in current.items():
        if type(k) is not bytes or type(v) is not bytes or max(len(k),len(v))>s.MAX_BYTES:
            out['input_bounded']=False; return out
        total+=len(k)+len(v)
        if total>s.MAX_TOTAL:
            out['input_bounded']=False; return out
    names,stores,paths,rows={},{},{},[]
    external_keys=set()
    account_pairs=set()
    message_ids=set()
    canonical_ids=set()
    ordered_names={}
    conflicting=set()
    def register(db,partition,name):
        ordered=list(dict.fromkeys(x.lower() for x in UUID.findall(name)))
        if db in names and (names[db]!=partition or ordered_names[db]!=ordered):
            out['db_name_conflicts']+=1
            conflicting.add(db)
        names[db]=partition
        ordered_names[db]=ordered
    for k,v in current.items():
        try:
            db,store,index,p=prefix(k)
            if not db and not store and not index and k[p:p+1]==b'\xc9':
                r=s.Reader(k[p+1:])
                r.take(r.uint()*2).decode('utf-16-be')
                name=r.take(r.uint()*2).decode('utf-16-be')
                s.need(r.p==len(r.data) and 1<=len(v)<=8)
                mapped_db=int.from_bytes(v,'little'); s.need(0<mapped_db<2**63)
                partition=set(x.lower() for x in UUID.findall(name))
                register(mapped_db,partition,name)
                out['global_db_names']+=1
            elif db and not store and not index and k[p:]==b'\1':
                name=v.decode('utf-16-be')
                register(db,set(x.lower() for x in UUID.findall(name)),name)
                out['db_names']+=1
            elif db and not store and not index and k[p:p+1]==b'2':
                r=s.Reader(k[p+1:]); sid=r.uint(); kind=r.take(1); s.need(r.p==len(r.data))
                if kind==b'\0': stores[db,sid]=s._category(v)
                elif kind==b'\1': paths[db,sid]=s._keypath(v)
            elif db and store and index==1: rows.append((db,store,k[p:],v))
            elif db and store and index==3: external_keys.add((db,store,k[p:]))
        except Exception: out['invalid']+=1
    out['external_entries']=len(external_keys)
    for db in conflicting:
        names[db]=set()
        ordered_names[db]=[]
    out['db_names_with_uuid']=sum(bool(x) for x in names.values())
    out['db_names_with_multiple_uuid']=sum(len(x)>1 for x in names.values())
    out['db_partition_groups']=len({tuple(sorted(x)) for x in names.values() if x})
    for db,store,key,value in rows:
        out['rows']+=1
        message=stores.get((db,store)) in ('messages','message_related')
        out['message_store_rows']+=message
        try:
            obj=s._decode(value); out['decoded']+=1; out['message_store_decoded']+=message
            kr=s.Reader(key); primary=s._idb_key(kr); s.need(kr.p==len(key))
            matched=False
            if (db,store) in paths:
                try: matched=s._equal(primary,s._at(obj,paths[db,store]))
                except s.Invalid: pass
                out['all_store_key_matches']+=matched
                if message: out['message_store_key_matches' if matched else 'message_store_key_mismatches']+=1
            flags=set(); matches=set(); partition=names.get(db,set())
            out['rows_with_partition_uuid']+=bool(partition)
            for node,depth,encoded,inherited_scope in _walk(obj,out):
                roles={role:[] for role in FIELDS}
                for k,v in node.items():
                    normalized=_norm(k)
                    for role,fields in FIELDS.items():
                        if normalized in fields and (_present(v) or type(v) is dict):
                            if role in ('created','modified') and not s._timestamp(v): continue
                            roles[role].append(v)
                            flags.add(role+'_'+('encoded_rows' if encoded else 'nested_rows' if depth else 'top_rows'))
                            if role in ('account','tenant','sender') and type(v) is str:
                                parts=set(x.lower() for x in UUID.findall(v))
                                if parts & partition: matches.add(role)
                                ordered=ordered_names.get(db,[])
                                if role in ('account','tenant') and len(ordered)==2:
                                    if ordered[0] in parts: flags.add(role+'_first_component_rows')
                                    if ordered[1] in parts: flags.add(role+'_second_component_rows')
                out['primary_matches_nested_identity']+=bool(depth and any(s._equal(primary,x) for x in roles['identity']))
                out['primary_matches_scope']+=any(s._equal(primary,x) for x in roles['scope'])
                out['identity_is_epoch']+=any(type(x) is str and x.isascii() and x.isdigit() and len(x)==13 and s._timestamp(int(x)) for x in roles['identity'])
                out['scope_has_thread_shape']+=any(type(x) is str and x.startswith('19:') and '@thread.' in x for x in roles['scope'])
                message_shape=bool(roles['identity'] and roles['created'] and roles['body'])
                out['message_shaped_nodes']+=message_shape
                out['scope_inherited_nodes']+=inherited_scope
                out['message_shaped_with_ancestor_scope']+=message_shape and inherited_scope
                out['message_shaped_with_primary_scope']+=message_shape and type(primary) is str and primary.startswith('19:') and '@thread.' in primary
                candidate=bool(roles['identity'] and roles['scope'] and roles['created'] and roles['body'])
                if candidate:
                    scopes=[x for x in roles['scope'] if type(x) is str and x]
                    ids=[x for x in roles['identity'] if type(x) in (str,int)]
                    normalized={_norm(k):v for k,v in node.items()}
                    for field,label in (('id','candidate_identifier_nodes'),('messageid','candidate_message_identifier_nodes'),('clientmessageid','candidate_client_identifier_nodes')):
                        out[label]+=field in normalized
                    canonical=next((normalized[k] for k in ('messageid','id','clientmessageid') if type(normalized.get(k)) in (str,int)),None)
                    if canonical is not None:
                        for scope in scopes: canonical_ids.add((db,scope,canonical))
                    root_scopes=[v for k,v in obj.items() if _norm(k) in FIELDS['scope']] if type(obj) is dict else []
                    out['candidate_scope_primary_matches']+=any(s._equal(primary,x) for x in scopes)
                    out['candidate_scope_root_matches']+=any(s._equal(x,y) for x in scopes for y in root_scopes)
                    times=[]
                    for v in roles['created']:
                        if type(v) is str:
                            times.append(round(datetime.datetime.fromisoformat(v.replace('Z','+00:00')).timestamp()*1000))
                        elif type(v) is tuple: times.append(v[1])
                        else: times.append(v)
                    out['candidate_identity_time_matches']+=any(str(t)==str(i) for t in times for i in ids)
                    for scope in scopes:
                        for identity in ids:
                            marker=(db,scope,identity)
                            out['candidate_duplicate_scoped_identities']+=marker in message_ids
                            message_ids.add(marker)
                out['nested_structural_candidates']+=candidate and depth>0
                out['all_store_structural_candidates']+=candidate and depth==0 and matched
                out['all_store_nested_candidates']+=candidate and depth>0 and matched
                for a in roles['account']:
                    for t in roles['tenant']:
                        if type(a) is str and type(t) is str:
                            account_pairs.add((db,a,t))
                            au=set(x.lower() for x in UUID.findall(a)); tu=set(x.lower() for x in UUID.findall(t))
                            out['partition_pair_component_matches']+=bool(au & partition and tu & partition and (au & partition)!=(tu & partition))
                out['message_store_structural_candidates']+=candidate and message and depth==0 and matched
                out['nested_account_tenant_pairs']+=bool(depth and roles['account'] and roles['tenant'])
            for label in flags: out[label]+=1
            for role in matches: out[role+'_partition_matches']+=1
            out['partition_pair_rows']+=('account' in matches and 'tenant' in matches)
        except s.External:
            out['external']+=1
            out['external_with_external_entry']+=(db,store,key) in external_keys
        except s.Unsupported:
            out['unsupported']+=1
            out['unsupported_with_external_entry']+=(db,store,key) in external_keys
        except Exception: out['invalid']+=1
    out['account_tenant_distinct_pairs']=len(account_pairs)
    out['candidate_scoped_identities']=len(message_ids)
    out['candidate_canonical_identities']=len(canonical_ids)
    return out
