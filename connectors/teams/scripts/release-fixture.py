"""Write one synthetic Teams cache generation from JSON rows on stdin."""
import json
from pathlib import Path
import sys

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'validation'))
from test_serialization import dataset
from test_current_store import batch, edit, log

cache = Path(sys.argv[1])
cache.mkdir(mode=0o700, parents=True, exist_ok=True)
fixture = json.load(sys.stdin)
chains = {}
for row in fixture['rows']:
    root = row.get('parentMessageId', row['id'])
    conversation = row['conversationId']
    chain = chains.setdefault((conversation, root), dict(conversationId=conversation, replyChainId=root, messageMap={}))
    chain['messageMap'][row['id']] = row
view = dataset(list(chains.values()), category='replychains-2')
view.update(dataset(fixture['conversations'], category='conversations', db=2))
for db, manager in [(1, 'replychain'), (2, 'conversation')]:
    name = f"Teams:{manager}-manager:react-web-client:{fixture['tenant']}:{fixture['account']}:en-us"
    view[bytes([0, db, 0, 0, 1])] = name.encode('utf-16-be')
(cache / 'CURRENT').write_bytes(b'MANIFEST-000001\n')
(cache / 'MANIFEST-000001').write_bytes(log(edit()))
pending = cache / 'pending'
pending.write_bytes(log(batch(1, [(key, 1, value) for key, value in view.items()])))
pending.replace(cache / '000003.log')
