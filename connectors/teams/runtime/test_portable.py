"""Subprocess and macOS discovery tests operate only in isolated synthetic homes."""
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import bridge as b
from test_bridge import CHAT, CHANNEL, TENANT, USER, chain, message, view
from test_current_store import batch, edit, log


class PortableTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        self.cache = self.root/'fixture'
        self.env = {'HOME':str(self.root),'EXANGELOS_HOME':str(self.root/'state')}
        self.install()

    def install(self, data=None, path=None):
        path = path or self.cache
        path.mkdir(parents=True,exist_ok=True)
        current = view() if data is None else data
        (path/'CURRENT').write_bytes(b'MANIFEST-000001\n')
        (path/'MANIFEST-000001').write_bytes(log(edit()))
        (path/'000003.log').write_bytes(log(batch(1, [(k,1,v) for k,v in current.items()])))

    def call(self, cmd='resolve', code=0, **request):
        request.setdefault('cachePath', str(self.cache))
        proc = subprocess.run([sys.executable,b.__file__,cmd],input=json.dumps(request).encode(),
                              capture_output=True,env=self.env,timeout=15)
        self.assertEqual(proc.returncode,code,proc.stderr)
        self.assertEqual(proc.stderr,b'')
        if code:
            self.assertEqual(proc.stdout,b'')
            return
        return json.loads(proc.stdout)

    def test_independent_pins_physical_identity_and_account_switch(self):
        self.install(view([chain(),chain(CHANNEL)]))
        one = self.call(selection=CHAT)['scope']
        two = self.call(selection=CHANNEL)['scope']
        self.assertNotEqual(one,two)
        self.assertEqual(one,self.call(selection='scope-'+one)['scope'])
        self.call('configured-snapshot', scope=one,includeMessagePreview=False)
        self.install(view(user=TENANT))
        self.call(selection='scope-'+one,code=24)
        self.cache.rename(self.root/'old')
        self.install(view([chain(),chain(CHANNEL)]))
        self.call(selection='scope-'+one,code=24)
        self.assertNotEqual(one,self.call(selection=CHAT)['scope'])

    def test_two_users_same_tenant_require_explicit_account_and_keep_pin(self):
        values = view()
        other = view(user=TENANT)
        values.update({bytes((k[0],k[1]+2))+k[2:]: v for k,v in other.items()})
        self.install(values)
        self.call(selection=CHAT,code=23)
        owner = TENANT+'/'+USER
        second = TENANT+'/'+TENANT
        first = self.call(selection=CHAT,account=owner)['scope']
        self.assertNotEqual(first,self.call(selection=CHAT,account=second)['scope'])
        self.call('configured-snapshot',scope=first,account=owner,includeMessagePreview=False)
        self.call('configured-snapshot',scope=first,account=second,includeMessagePreview=True,code=24)
        self.call(selection=CHAT,account='unqualified',code=20)

    def test_copied_channel_link_group_and_tenant(self):
        self.install(view([chain(CHANNEL)]))
        from test_bridge import GROUP
        url = 'https://teams.microsoft.com/l/channel/'+CHANNEL+'/Room?groupId='+GROUP+'&tenantId='+TENANT
        self.assertEqual(self.call(selection=url),self.call(selection=CHANNEL))
        self.call(selection=url.replace(GROUP,USER),code=23)
        self.call(selection=url.replace(TENANT,USER),code=22)

    def test_channel_thread_empty_then_growth(self):
        self.install(view([chain(CHANNEL)]))
        link = 'https://teams.microsoft.com/l/message/'+CHANNEL+'/100?tenantId='+TENANT
        result = self.call(selection=link,scope='replies')
        self.assertEqual(result['label'],'Replies in Project Room (root 100)')
        pin = result['scope']
        self.assertEqual(result,self.call(selection='scope-'+pin))
        args = {'scope':pin,'includeMessagePreview':True}
        self.assertEqual(self.call('configured-snapshot',**args)['messages'],[])
        self.install(view([chain(CHANNEL,rows=[message(),message('101')]),chain(CHANNEL,'200',[message('200')])]))
        reply, = self.call('configured-snapshot',**args)['messages']
        self.assertIn('/101?',reply['permalink'])
        self.assertEqual(pin,self.call(selection=link.replace('/100?','/101?'),scope='replies')['scope'])

    def test_numeric_message_ids_and_deleted_text_in_native_cache(self):
        root, reply = 1700000000000.0, 1700000000001.0
        record = {'conversationId':CHANNEL, 'replyChainId':root, 'messageMap':{
            str(int(root)):message(root, parentMessageId=root),
            str(int(reply)):message(reply, parentMessageId=root, deletionInfo={}, content='Deleted fixture text')
        }}
        self.install(view([record]))
        selection = self.call(selection=CHANNEL)['scope']
        rows = self.call('configured-snapshot',scope=selection,includeMessagePreview=True)['messages']
        self.assertEqual(len(rows),2)
        live, = [row for row in rows if row['parent'] is None]
        deleted, = [row for row in rows if row['parent'] == live['id']]
        self.assertIn('/1700000000001?',deleted['permalink'])
        self.assertEqual(live['preview'],'Hello world')
        self.assertNotIn('preview',deleted)
        self.assertNotIn('Deleted fixture text',json.dumps(rows))

    def test_invalid_double_ids_refuse_resolution(self):
        for value in (0.5, -1.0, float(2**53), float('inf'), float('nan')):
            with self.subTest(value=value):
                record = chain()
                record['messageMap']['100']['id'] = value
                self.install(view([record]))
                self.call(selection=CHAT,code=21)

    def test_legacy_and_invalid_state(self):
        self.call('setup',code=20)
        self.call('snapshot',code=20)
        self.call('configure',code=20,selectionToken='synthetic')
        self.call(selection='selected',code=20)
        self.call(selection='scope-'+'0'*64,code=24)
        self.call(selection=CHANNEL,code=22)
        pin = self.call(selection=CHAT)['scope']
        state = self.root/'state/connectors/teams'/('pin-'+pin+'.json')
        self.assertEqual(state.stat().st_mode & 0o777,0o600)
        self.assertNotIn('Hello world',state.read_text())
        state.chmod(0o644)
        self.call(selection='scope-'+pin,code=21)

    def test_discovery_ambiguity_and_unreadable(self):
        base = self.root/'Library/Containers/com.microsoft.teams2'
        for numbered in ('one','two'):
            path = base/numbered/next(iter(b.current_store.ORIGINS))
            self.install(view(user='8:orgid:'+USER),path)
        def resolve():
            payload = io.BytesIO(json.dumps({'selection':CHAT}).encode())
            with patch.object(sys,'stdin',io.TextIOWrapper(payload)):
                return b.run('resolve')
        with patch.dict(os.environ,self.env,clear=True), patch.object(sys,'platform','darwin'):
            with self.assertRaises(b.native.Refusal) as error:
                resolve()
            self.assertEqual(error.exception.code,23)
            (path/'CURRENT').write_bytes(b'broken')
            with self.assertRaises(Exception):
                resolve()
