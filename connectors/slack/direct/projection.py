"""Path-specific in-memory Redux projection. Never print returned values."""
import re
import skip_v8
field_v8=skip_v8.field_v8
class Reader(skip_v8.Reader):
    def select(self,data):
        self.data=memoryview(data);self.pos=0;self.nodes=0;self.objects=0
        if self.byte()!=255:raise ValueError('header')
        self.version=self.uint()
        if self.version not in (13,14,15,16):raise ValueError('version')
        value=self.read('root',0)
        if self.pos!=len(self.data):raise ValueError('trailing')
        return value
    def name(self,tag,role):
        if tag in (ord('I'),ord('U')):
            n=self.uint();return str(n) if role in ('container','reactions','users') else None
        if tag not in field_v8._ENCODINGS:raise ValueError('key_tag')
        span=self.string_span(tag)
        allowed={
          'root':('messages','threads','bootData','selfTeamIds','channels','reactions','teams','users'),
          'bootData':('team_id','user_id','team_domain'),
          'accountTeam':('id','domain'),
          'accountUser':('id','team_id','name','profile'),
          'profile':('display_name','real_name'),
          'selfTeamIds':('teamId','defaultWorkspaceId'),
          'message':('type','subtype','ts','thread_ts','channel','channel_id','team','text','edited','reactions','user','bot_id','username','_rxn_key','_hidden_stub','no_display'),
          'edited':('ts',),
          'reaction':('name','users','count'),
          'channel':('id','name','user','context_team_id','is_channel','is_group','is_im','is_mpim','is_private'),
          'container':('messages','replies','data'),
        }.get(role,())
        for k in allowed:
            if span==k.encode(field_v8._ENCODINGS[tag]):return k
        if role in ('messages','threads','channels','container','reactions','users','reactionStore','teams','accountUsers'):
            try:s=str(span,field_v8._ENCODINGS[tag])
            except UnicodeError:raise ValueError('encoding')
            if role=='teams' and re.fullmatch(r'T[A-Z0-9]{6,30}',s):return s
            if role=='accountUsers' and re.fullmatch(r'[UW][A-Z0-9]{6,30}',s):return s
            if role=='container':return s
            if (role=='reactionStore' and re.fullmatch(r'message-[0-9]{1,20}\.[0-9]{1,10}-[CDG][A-Z0-9]{6,30}',s)):return s
            if (role in ('messages','threads','channels') and re.fullmatch(r'[CDG][A-Z0-9]{6,30}',s)) or (role=='container' and re.fullmatch(r'[0-9]{1,20}(\.[0-9]{1,10})?',s)) or (role in ('reactions','users') and s.isdigit()):return s
        return None
    def child(self,role,key):
        if role=='root':return {'reactions':'reactionStore','users':'accountUsers'}.get(key,key)
        if role=='teams':return 'accountTeam'
        if role=='accountUsers':return 'accountUser'
        if role=='accountUser':return 'profile' if key=='profile' else 'string'
        if role in ('profile','accountTeam'):return 'string'
        if role=='reactionStore':return 'reactions'
        if role in ('bootData','selfTeamIds','edited'):return 'string'
        if role in ('messages','threads'):return 'container'
        if role=='channels':return 'channel'
        if role=='channel':return 'bool' if key.startswith('is_') else 'string'
        if role=='container':return 'container' if key in ('messages','replies','data') else 'message'
        if role=='message' and key=='thread_ts':return 'thread'
        if role=='message' and key in ('_hidden_stub','no_display'):return 'bool'
        if role=='message':return key if key in ('edited','reactions') else 'string'
        if role=='reactions':return 'reaction'
        if role=='reaction':return 'users' if key=='users' else 'number' if key=='count' else 'string'
        if role=='users':return 'string'
        return 'skip'
    def read(self,role,depth):
        self.node(depth);start=self.pos;tag=self.tag()
        if role=='skip':self.pos=start;return self.value(depth,'skip')
        if role=='thread' and tag in (ord('0'),ord('_')):return None
        if role in ('string','thread') and tag in field_v8._ENCODINGS:
            return str(self.string_span(tag),field_v8._ENCODINGS[tag])
        if role=='thread':
            self.pos=start;self.value(depth,'skip');return {'unsupported':True}
        if role=='bool' and tag in (ord('T'),ord('F')):return tag==ord('T')
        if role=='number' and tag in (ord('I'),ord('U')):
            n=self.uint();return (n>>1)^-(n&1) if tag==ord('I') else n
        if tag==ord('o'):
            self.objects+=1;out={};count=0
            while True:
                tag=self.tag()
                if tag==ord('{'):break
                key=self.name(tag,role);count+=1
                v=self.read(self.child(role,key) if key is not None else 'skip',depth+1)
                if key is not None:
                    if key in out:raise ValueError('duplicate')
                    out[key]=v
            if self.uint()!=count:raise ValueError('count')
            return out
        if tag in (ord('A'),ord('a')):
            self.objects+=1;length=self.uint()
            if length>100000:raise ValueError('length')
            out={};count=0
            if tag==ord('A'):
                for i in range(length):out[str(i)]=self.read(self.child(role,str(i)),depth+1)
            end=ord('$') if tag==ord('A') else ord('@')
            while True:
                keytag=self.tag()
                if keytag==end:break
                key=self.name(keytag,role);count+=1
                v=self.read(self.child(role,key) if key is not None else 'skip',depth+1)
                if key is not None:
                    if key in out:raise ValueError('duplicate')
                    out[key]=v
            if self.uint()!=count or self.uint()!=length:raise ValueError('count')
            return out
        self.pos=start;self.value(depth,'skip');return None

def project(data):
    return Reader(data,field_v8.Limits(max_bytes=16*1024*1024,max_nodes=1000000)).select(data)

def summary(value):
    counts=dict.fromkeys(('workspace_identity','owner_identity','conversations','message_containers','messages_with_identity','messages_with_body','replies','messages_with_reactions','reaction_entries','channel_contexts','reaction_store_entries','reaction_joins','reaction_rows','reaction_users','reaction_count_matches','hidden_stubs'),0)
    boot=value.get('bootData') or {};team=value.get('selfTeamIds') or {}
    counts['workspace_identity']=int(bool(boot.get('team_id') or team.get('teamId') or team.get('defaultWorkspaceId')))
    counts['owner_identity']=int(bool(boot.get('user_id')))
    reactions=value.get('reactions') or {}
    counts['reaction_store_entries']=len(reactions)
    counts['channel_contexts']=len(value.get('channels') or {})
    def walk(v):
        if not isinstance(v,dict):return
        if isinstance(v.get('ts'),str):
            counts['hidden_stubs']+=v.get('_hidden_stub') is True or v.get('no_display') is True
            rx=reactions.get(v.get('_rxn_key'))
            if isinstance(rx,dict):
                counts['reaction_joins']+=1
                for reaction in rx.values():
                    if not isinstance(reaction,dict):continue
                    counts['reaction_rows']+=1
                    users=reaction.get('users') or {}
                    counts['reaction_users']+=len(users)
                    counts['reaction_count_matches']+=reaction.get('count')==len(users)
            counts['messages_with_identity']+=1;counts['messages_with_body']+=isinstance(v.get('text'),str)
            counts['replies']+=isinstance(v.get('thread_ts'),str) and v['thread_ts']!=v['ts']
            counts['messages_with_reactions']+=isinstance(v.get('reactions'),dict)
            counts['reaction_entries']+=len(v.get('reactions') or {})
            return
        for child in v.values():walk(child)
    for key in ('messages','threads'):
        container=value.get(key) or {}
        counts['conversations']+=len(container)
        for channel in container.values():
            counts['message_containers']+=isinstance(channel,dict)
            walk(channel)
    return counts
