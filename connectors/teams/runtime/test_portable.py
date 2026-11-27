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
import ledger
from test_serialization import key, val
from test_bridge import CHAT, CHANNEL, TENANT, USER, chain, message, view
from test_current_store import batch, edit, ik, log, table


class PortableTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        self.cache = self.root/'fixture'
        self.env = {'HOME':str(self.root),'EXANGELOS_HOME':str(self.root/'state')}
        self.install()

    def test_alarm_counts_only_monotonic_time_across_wakes(self):
        with patch.object(b.time, 'monotonic', side_effect=[100, 107, 114, 140]), \
             patch.object(b.signal, 'signal') as install, patch.object(b.signal, 'setitimer') as timer:
            b.arm_read_deadline(40)
            callback = install.call_args.args[1]
            for remaining in (33, 26):
                callback()
                timer.assert_called_with(b.signal.ITIMER_REAL, remaining)
            with self.assertRaises(b.ReadDeadline):
                callback()

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

    def test_default_layout_and_upgrade_from_external_private_state(self):
        del self.env['EXANGELOS_HOME']
        base = self.root / '.local/share/exangelos'
        installed = base / 'connectors/teams'
        installed.mkdir(parents=True)
        manifest = installed / 'connector.json'
        manifest.write_text('{}')
        pin = self.call(selection=CHAT)['scope']
        current = base / 'connector-state/teams'
        with patch.dict(os.environ, self.env, clear=True):
            self.assertEqual(ledger.ledger_path(), current / 'ledger.sqlite3')
            snapshot = self.call('configured-snapshot', scope=pin, includeMessagePreview=False)
            baseline = ledger.reconcile(dict(snapshot=snapshot, observedAt=1000))
            self.assertEqual(list(installed.iterdir()), [manifest])
            manifest.unlink()
            installed.rmdir()
            current.rename(installed)
            self.assertEqual(self.call(selection='scope-'+pin)['scope'], pin)
            self.assertEqual(ledger.ledger_path(), installed / 'ledger.sqlite3')
            resumed = ledger.reconcile(dict(snapshot=snapshot, observedAt=2000, cursor=baseline['cursor']))
            self.assertFalse(resumed['events'])
            self.assertFalse(current.exists())

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
        self.call(selection=url.replace(GROUP,USER),code=35)
        self.call(selection=url.replace(TENANT,USER),code=22)

    def test_missing_thread_can_hydrate_from_a_reply_without_the_root(self):
        url = 'https://teams.microsoft.com/l/message/'+CHANNEL+'/100?tenantId='+TENANT
        pin = self.call(selection=url, scope='replies')['scope']
        args = dict(scope=pin, includeMessagePreview=True)
        self.assertEqual(self.call('configured-snapshot', **args)['missing'], 'thread')
        self.install(view([chain(CHANNEL, rows=[message('101')])]))
        snapshot = self.call('configured-snapshot', **args)
        self.assertNotIn('missing', snapshot)
        self.assertEqual(len(snapshot['messages']), 1)
        self.assertEqual(self.call(selection=url, scope='replies')['scope'], pin)

    def test_group_constraint_survives_restart_and_never_releases_unverified_rows(self):
        from test_bridge import GROUP
        link = 'https://teams.microsoft.com/l/message/'+CHANNEL+'/100?groupId='+GROUP+'&tenantId='+TENANT
        constrained = self.call(selection=link, scope='replies')['scope']
        wrong = self.call(selection=link.replace(GROUP, USER), scope='replies')['scope']
        self.assertNotEqual(wrong, constrained)
        args = dict(scope=constrained, includeMessagePreview=True)
        self.assertEqual(self.call('configured-snapshot', **args)['missing'], 'thread')
        self.install(view([chain(CHANNEL, rows=[message('101')])]))
        mismatch = self.call('configured-snapshot', scope=wrong, includeMessagePreview=True)
        self.assertTrue(mismatch['groupMismatch'])
        self.assertEqual(mismatch['messages'], [])
        self.assertEqual(len(self.call('configured-snapshot', **args)['messages']), 1)
        self.assertEqual(constrained, self.call(selection=link, scope='replies')['scope'])
        self.call(selection=link.replace(GROUP, USER), scope='replies', code=35)

    def test_late_message_binds_containing_thread_and_preserves_hint(self):
        base = 'https://teams.microsoft.com/l/message/'+CHANNEL+'/'
        watch = self.call(selection=base+'101', scope='replies')['scope']
        wrong = self.call(selection=base+'101?parentMessageId=200', scope='replies')['scope']
        def snapshot(pin):
            return self.call('configured-snapshot', scope=pin, includeMessagePreview=False)
        self.assertEqual(snapshot(watch)['missing'], 'thread')
        self.install(view([chain(CHANNEL, rows=[message('101'),message('102')])]))
        self.assertEqual(len(snapshot(watch)['messages']), 2)
        self.assertEqual(snapshot(wrong)['messages'], [])
        self.assertTrue(snapshot(wrong)['threadMismatch'])
        self.assertEqual(self.call(selection=base+'102',scope='replies')['scope'], watch)
        self.install(view([chain(CHANNEL, rows=[message('102')])]))
        self.assertEqual(len(snapshot(watch)['messages']), 1)
        self.assertEqual(self.call(selection='scope-'+watch)['scope'], watch)

    def test_unique_present_account_precedes_absent_fallback(self):
        self.install(view([chain(CHANNEL)]))
        link = 'https://teams.microsoft.com/l/message/'+CHANNEL+'/100'
        first = self.call(selection=link, scope='replies')
        initial = view([chain(CHANNEL)])
        initial.update({bytes((k[0], k[1]+2))+k[2:]: v for k,v in view(user=TENANT).items()})
        self.install(initial)
        self.assertEqual(self.call(selection=link, scope='replies'), first)
        self.call(selection=link.replace('/100','/200'), scope='replies', code=23)

    def test_deferred_group_applies_to_aliases_in_both_orders(self):
        from test_bridge import GROUP
        for group_first, mid in [(True,'100'), (False,'200')]:
            channel = CHANNEL.replace('channel', 'channel'+mid)
            bare = 'https://teams.microsoft.com/l/message/'+channel+'/'+mid
            qualified = bare+'?groupId='+GROUP
            links = (qualified, bare) if group_first else (bare, qualified)
            pin = self.call(selection=links[0], scope='replies')['scope']
            self.assertEqual(pin, self.call(selection=links[1], scope='replies')['scope'])
            data = view([chain(channel,mid,[message(mid),message('999')])])
            self.install({k:v for k,v in data.items() if k[:4] != bytes((0,2,1,1))})
            for link in links:
                self.assertEqual(pin, self.call(selection=link, scope='replies')['scope'])
            snapshot = self.call('configured-snapshot',scope=pin,includeMessagePreview=True)
            self.assertTrue(snapshot['awaitingGroup'])
            self.assertEqual(snapshot['messages'], [])
            self.install(data)
            self.assertEqual(len(self.call('configured-snapshot',scope=pin,includeMessagePreview=True)['messages']),1)

    def test_conflicting_containing_threads_and_unverified_hint(self):
        base = 'https://teams.microsoft.com/l/message/'+CHANNEL+'/101'
        plain = self.call(selection=base, scope='replies')['scope']
        hinted = self.call(selection=base+'?parentMessageId=200', scope='replies')['scope']
        args = dict(includeMessagePreview=True)
        other = chain(CHANNEL,'200',[message('202')])
        self.install(view([other]))
        self.assertEqual(self.call('configured-snapshot', scope=hinted, **args)['missing'], 'thread')
        self.install(view([chain(CHANNEL, rows=[message('101')]),chain(CHANNEL,'200',[message('101')])]))
        for pin in (plain,hinted):
            snapshot = self.call('configured-snapshot', scope=pin, **args)
            self.assertTrue(snapshot['threadMismatch'])
            self.assertEqual(snapshot['messages'], [])
        self.call(selection=base, scope='replies', code=36)

    def test_verified_reply_and_root_aliases_survive_complete_eviction(self):
        base = 'https://teams.microsoft.com/l/message/'+CHANNEL+'/'
        self.install(view([chain(CHANNEL, rows=[message('101')])]))
        first = self.call(selection=base+'101', scope='replies')['scope']
        self.install(view())
        for mid in ('100','101'):
            self.assertEqual(first, self.call(selection=base+mid, scope='replies')['scope'])
        self.call(selection=base+'101?parentMessageId=200', scope='replies', code=36)

    def test_conversation_parent_constraint_precedes_any_delivery(self):
        self.install(view([chain(CHANNEL,'200',[message('202')])]))
        base = 'https://teams.microsoft.com/l/message/'+CHANNEL+'/101?parentMessageId='
        ordinary = self.call(selection=CHANNEL)['scope']
        good = self.call(selection=base+'100', scope='conversation')['scope']
        bad = self.call(selection=base+'200', scope='conversation')['scope']
        def read(pin):
            return self.call('configured-snapshot', scope=pin, includeMessagePreview=True)
        self.assertEqual(read(good)['missing'], 'conversation')
        self.assertEqual(read(bad)['messages'], [])
        self.install(view([chain(CHANNEL,'100',[message('101')]),chain(CHANNEL,'200',[message('202')])]))
        self.assertEqual(len(read(good)['messages']),2)
        self.assertEqual(self.call(selection=CHANNEL)['scope'], ordinary)
        self.assertTrue(read(bad)['threadMismatch'])
        self.assertEqual(read(bad)['messages'],[])
        self.assertEqual(self.call(selection=base+'100',scope='conversation')['scope'],good)

    def test_plain_channel_and_guarded_permalink_survive_group_discovery(self):
        from test_bridge import GROUP
        plain = self.call(selection=CHANNEL)['scope']
        url = 'https://teams.microsoft.com/l/message/'+CHANNEL+'/101?parentMessageId=100&groupId='+GROUP
        guarded = self.call(selection=url,scope='conversation')['scope']
        self.assertNotEqual(plain, guarded)
        self.install(view([chain(CHANNEL,rows=[message('101')])]))
        self.assertEqual(len(self.call('configured-snapshot',scope=guarded,includeMessagePreview=True)['messages']),1)
        self.assertEqual(self.call(selection=CHANNEL)['scope'],plain)
        self.assertEqual(self.call(selection=url,scope='conversation')['scope'],guarded)

    def test_independent_plain_channel_survives_an_unrelated_wrong_permalink_group(self):
        plain = self.call(selection=CHANNEL)['scope']
        link = 'https://teams.microsoft.com/l/message/'+CHANNEL+'/101?parentMessageId=100&groupId='+USER
        guarded = self.call(selection=link,scope='conversation')['scope']
        self.install(view([chain(CHANNEL,rows=[message('101')])]))
        bad = self.call('configured-snapshot',scope=guarded,includeMessagePreview=True)
        self.assertTrue(bad['groupMismatch'])
        self.assertEqual(bad['messages'],[])
        self.assertEqual(self.call(selection=CHANNEL)['scope'],plain)
        self.assertEqual(len(self.call('configured-snapshot',scope=plain,includeMessagePreview=True)['messages']),1)

    def test_plain_reference_cannot_escape_a_contradicted_pending_group(self):
        from test_bridge import GROUP
        url = 'https://teams.microsoft.com/l/channel/'+CHANNEL+'/Room?groupId='
        waiting = self.call(selection=url+USER)['scope']
        self.assertEqual(self.call(selection=CHANNEL)['scope'],waiting)
        self.install(view([chain(CHANNEL)]))
        result = self.call('configured-snapshot',scope=waiting,includeMessagePreview=True)
        self.assertTrue(result['groupMismatch'])
        self.assertEqual(result['messages'],[])
        self.call(selection=CHANNEL,code=35)
        self.assertNotEqual(self.call(selection=url+GROUP)['scope'],waiting)
        self.call(selection=CHANNEL,code=35)

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

    def test_compound_chain_with_dedupe_keys_and_malformed_peer_resumes(self):
        record = chain(CHANNEL)
        record['messageMap'] = {
            'root-key': message(dedupeKey='root-key', conversationId=CHANNEL),
            'unbound': message('102', dedupeKey='other', conversationId=CHANNEL),
            '999': message('102', conversationId=CHANNEL),
            '997': message('bad-id', conversationId=CHANNEL),
            '996': None,
            '995': message('995', conversationId=CHAT),
        }
        def install():
            data = view([record])
            del data[b'\0\1\1\1' + key('0')]
            path = key('conversationId')[1:] + key('replyChainId')[1:]
            data[b'\0\1\0\0\x32\1\1'] = b'\0\0\2\2' + path
            prefix = b'\0\1\1\1\4\2'
            data[prefix + key(CHANNEL) + key('100')] = val(record)
            data[prefix + key(CHAT) + key('100')] = b'\1\xff\x11\1'
            self.install(data)

        install()
        link = 'https://teams.microsoft.com/l/message/'+CHANNEL+'/'
        pin = self.call(selection=link+'100', scope='replies')['scope']
        self.assertEqual(pin, self.call(selection=link+'100?parentMessageId=100', scope='replies')['scope'])
        self.call(selection=link+'102', scope='replies', code=22)
        self.call(selection=link+'999', scope='replies', code=22)
        def poll(now, cursor=None):
            snap = self.call('configured-snapshot', scope=pin, includeMessagePreview=False)
            request = {'snapshot':snap, 'observedAt':now}
            if cursor is not None:
                request['cursor'] = cursor
            return ledger.reconcile(request, self.root/'ledger.sqlite3')

        baseline = poll(1795165200122)
        self.assertEqual(baseline['events'], [])
        record['messageMap']['reply-key'] = message('101', dedupeKey='reply-key', conversationId=CHANNEL)
        install()
        changed = poll(1795165200124, baseline['cursor'])
        event, = changed['events']
        self.assertEqual(event['type'], 'message.reply')
        self.assertIn('/101?', event['payload']['permalink'])
        self.assertEqual(poll(1795165200125, baseline['cursor']), changed)
        self.assertEqual(poll(1795165200125, changed['cursor'])['events'], [])
        record['messageMap']['998'] = record['messageMap'].pop('root-key')
        record['messageMap']['100'] = message('bad-id', conversationId=CHANNEL)
        install()
        self.call(selection=link+'100?parentMessageId=100', scope='replies', code=22)
        self.call('configured-snapshot', scope=pin, includeMessagePreview=False, code=22)
        self.call(selection=link+'101', scope='replies', code=22)

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
                self.call(selection=CHAT,code=22)

    def test_storage_failure_reports_only_the_file_class(self):
        pin = self.call(selection=CHAT)['scope']
        for name, code in [('000003.log', 32), ('MANIFEST-000001', 30)]:
            with self.subTest(name=name):
                (self.cache / name).write_bytes(b'synthetic invalid data')
                self.call('configured-snapshot', scope=pin, includeMessagePreview=False, code=code)
                self.install()
        self.call('configured-snapshot', scope=pin, includeMessagePreview=False)

    def test_diagnostic_contains_original_structure_without_values(self):
        pin = self.call(selection=CHAT)['scope']
        (self.cache/'MANIFEST-000001').write_bytes(b'synthetic confidential marker')
        request = dict(scope=pin, includeMessagePreview=False)
        proc = subprocess.run([sys.executable, b.__file__, 'configured-snapshot', '--diagnostic'],
                              input=json.dumps(request).encode(), capture_output=True, env=self.env, timeout=15)
        self.assertEqual(proc.returncode, 30)
        self.assertEqual(proc.stderr, b'')
        self.assertNotIn(b'confidential', proc.stdout)
        detail = json.loads(proc.stdout)
        self.assertEqual(set(detail), {'exception', 'errno', 'frames'})
        self.assertEqual(detail['exception'], 'Invalid')
        self.assertTrue(detail['frames'])
        self.assertTrue(all(module == 'current_store' and line > 0 for module, line in detail['frames']))

    def test_corrupt_table_exit(self):
        pin = self.call(selection=CHAT)['scope']
        pairs = [(ik(b'k', 1), b'value')]
        data = table(pairs)
        (self.cache/'MANIFEST-000001').write_bytes(log(edit(data, pairs)))
        (self.cache/'000002.ldb').write_bytes(data[:-1] + b'x')
        self.call('configured-snapshot', scope=pin, includeMessagePreview=False, code=31)

    def assert_acquire_failure(self, code):
        with patch.object(b, 'limits'), patch.object(sys, 'argv', ['bridge.py', 'configured-snapshot']), \
             patch.object(b, 'run', lambda _: b.acquire(self.cache)), \
             patch.object(sys, 'stdout', io.StringIO()) as out, patch.object(sys, 'stderr', io.StringIO()) as err:
            self.assertEqual(b.main(), code)
            self.assertEqual((out.getvalue(), err.getvalue()), ('', ''))

    def test_directory_replaced_between_opens(self):
        read = b.current_store.current_view
        def swap(path, expected_directory):
            path.rename(self.root/'old')
            self.install()
            return read(path, expected_directory)
        with patch.object(b.current_store, 'current_view', swap):
            self.assert_acquire_failure(33)

    def test_deadline_during_manifest_read(self):
        with patch.object(b.current_store, 'manifest', side_effect=b.read_deadline):
            self.assert_acquire_failure(34)

    def test_legacy_and_invalid_state(self):
        self.call('setup',code=20)
        self.call('snapshot',code=20)
        self.call('configure',code=20,selectionToken='synthetic')
        self.call(selection='selected',code=20)
        self.call(selection='scope-'+'0'*64,code=24)
        pending = self.call(selection=CHANNEL)['scope']
        self.assertEqual(self.call('configured-snapshot', scope=pending, includeMessagePreview=False)['missing'], 'conversation')
        pin = self.call(selection=CHAT)['scope']
        state = self.root/'state/connector-state/teams'/('pin-'+pin+'.json')
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
