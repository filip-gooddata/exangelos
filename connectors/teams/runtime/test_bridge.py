"""Native Teams store projections exercised with synthetic data only."""
import unittest
from unittest.mock import patch
from urllib.parse import quote

import bridge
import native_cache as n
from test_serialization import dataset

TENANT = '11111111-1111-1111-1111-111111111111'
USER = '22222222-2222-2222-2222-222222222222'
CHAT = '19:synthetic@thread.v2'
CHANNEL = '19:channel@thread.tacv2'
GROUP = '33333333-3333-3333-3333-333333333333'
STAMP = '2026-11-20T09:00:00.123Z'


def message(mid='100', **extra):
    return {'id':mid, 'content':'Hello world', 'originalArrivalTime':STAMP,
            'imDisplayName':'Ada', 'properties':{'emotions':[]}, **extra}


def chain(chat=CHAT, root='100', rows=None):
    values = [message()] if rows is None else rows
    return {'conversationId':chat, 'replyChainId':root, 'messageMap':{r['id']:r for r in values}}


def view(chains=None, tenant=TENANT, user=USER):
    chains = [chain()] if chains is None else chains
    chats = sorted({row['conversationId'] for row in chains})
    values = dataset(chains, category='replychains-2')
    values.update(dataset([{'id':chat, 'chatTitle':{'shortTitle':'Project Room'},'groupId':GROUP}
                           for chat in chats], category='conversations', db=2))
    for db, manager in enumerate(('replychain','conversation'),1):
        values[bytes((0,db,0,0,1))] = f'Teams:{manager}-manager:react-web-client:{tenant}:{user}:en-us'.encode('utf-16-be')
    return values


def select(chat, rows, consent=True):
    tables = n.stores(view([chain(chat, rows=rows)]))
    _, partition, records = tables[0]
    name, group, _ = n.conversation_metadata(tables,partition,chat)
    return n.snapshot_rows(b'k'*32,{'chat':chat,'root':None,'partition':partition},
                           n.messages(records,chat),name,group,consent)


class BridgeTests(unittest.TestCase):
    def test_context_authored_time_and_opt_in(self):
        row, = select(CHAT,[message()])
        self.assertEqual((row['conversationLabel'],row['sender'],row['preview'],row['messageTime']),
                         ('Project Room','Ada','Hello world',1795165200123))
        self.assertIn(quote(CHAT,safe=''),row['permalink'])
        self.assertIn(TENANT,row['permalink'])
        self.assertNotIn('preview', select(CHAT,[message()],False)[0])
        for epoch in ('1795165200123', 1795165200123):
            self.assertEqual(n.original_time(epoch),row['messageTime'])
        for invalid in ('42', '4102444800001','nan','-10'):
            self.assertIsNone(n.original_time(invalid))
        unknown, = select(CHAT,[message(imDisplayName='', originalArrivalTime=None, lastModifiedDateTime=STAMP)])
        self.assertFalse({'sender','messageTime'} & unknown.keys())

    def test_visible_excerpts(self):
        for text in ('password and token rotation', 'a' * 64, '[removed]', '123456', 'x = 2 < 3'):
            self.assertEqual(select(CHAT,[message(content=text)])[0]['preview'], text)
        self.assertEqual(n.preview(message(content='word ' * 1000)), ('word ' * 32))
        self.assertEqual(n.preview(message(content='hello\u202eworld\nmessage')), 'hello world message')
        with patch.dict('os.environ', {'SYNTHETIC_TOKEN':'not-for-wakes'}, clear=True):
            self.assertEqual(n.preview(message(content='password: not-for-wakes approved')), 'password: [redacted] approved')
        rich = ('<p>Hello <b>pass</b>word <a href="https://hidden.invalid">label</a> '
                '<span hidden>invisible</span><script>private</script><!-- comment -->'
                '<img src="internal"><blockquote>quoted reply</blockquote>tail</p>')
        self.assertEqual(n.preview(message(messageType='RichText/Html', content=rich)), 'Hello password label tail')
        styled = ('<div class="message-content"><span class="formatted" style="color:#cf2233; font-weight: bold">'
                  'status</span> <span style="color: rgb(25, 12, 0)">green</span>'
                  '<span class="visually-hidden">private</span><span aria-hidden="true">secret</span>'
                  '<span style="color:blue; display:none">secret</span></div>')
        self.assertEqual(n.preview(message(messageType='RichText/Html', content=styled)), 'status green')
        for change in ({'deletionInfo':{'time':STAMP}}, {'properties':{'deletetime':STAMP}},
                       {'redacted':True}, {'hidden':True}, {'messageType':'Unsupported'},
                       {'messageType':'RichText/Html', 'content':'<style>p{display:none}</style><p>private</p>'},
                       {'messageType':'RichText/Html', 'content':'<span hidden>private</p>'}):
            self.assertNotIn('preview', select(CHAT,[message(**change)])[0])
        self.assertNotIn('permalink',select('19:'+'='*380+'@thread.v2',[message()])[0])

    def test_quotes_not_parents_and_channel_parent_link(self):
        row, = select(CHAT,[message(content='<blockquote itemscope itemtype="http://schema.skype.com/Reply" itemid="99">Q</blockquote>')])
        self.assertIsNone(row['parent'])
        rows = select(CHANNEL,[message(),message('101')])
        root, = [row for row in rows if row['parent'] is None]
        reply, = [row for row in rows if row['parent']]
        self.assertEqual(reply['parent'],root['id'])
        self.assertIn('parentMessageId=100',reply['permalink'])

    def test_malformed_and_conflicting_rows_refuse(self):
        for rows in ([message(parentMessageId='87')], [message(content=None)]):
            with self.assertRaises(ValueError):
                select(CHANNEL,rows)
        with self.assertRaises(ValueError):
            n.stores(dataset([chain()],category='replychains-2'))

    def test_reference_syntax_and_scope(self):
        self.assertEqual(n.reference('https://teams.microsoft.com/l/chat/'+quote(CHAT,safe='')+'/conversations',None)[0], CHAT)
        for value,scope,code in [(CHAT,'replies',28), ('https://evil.invalid/l/chat/'+CHAT+'/conversations',None,20),
               ('https://teams.microsoft.com/l/message/'+CHAT+'/100',None,27),
               ('https://teams.microsoft.com/l/message/'+CHAT+'/100','replies',28), ('123456',None,29), ('selected',None,20)]:
            with self.assertRaises(n.Refusal) as failure:
                n.reference(value,scope)
            self.assertEqual(failure.exception.code,code)
