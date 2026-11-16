import json
from pathlib import Path
import sys

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'validation'))
from test_serialization import dataset
from test_action_probe import message
from test_current_store import batch, edit, log
from action_probe import fingerprint

root = Path(sys.argv[1]).resolve()
root.mkdir(mode=0o700, parents=True, exist_ok=True)
cache = root / 'cache'
cache.mkdir(exist_ok=True)
view = dataset([message(content='synthetic-marker-123 ' + sys.argv[2], chatId=sys.argv[3] if len(sys.argv) > 3 else 'synthetic-scope')])
(cache / 'CURRENT').write_bytes(b'MANIFEST-000001\n')
(cache / 'MANIFEST-000001').write_bytes(log(edit()))
(cache / '000003.log').write_bytes(log(batch(1, [(k, 1, v) for k, v in view.items()])))
key = b'k' * 32
config = root / 'config.json'
config.write_text(json.dumps({'key': key.hex(), 'cache': str(cache),
                             'scope': fingerprint(key, 'scope', [str(cache), 1, 'synthetic-scope']).hex()}))
config.chmod(0o600)
