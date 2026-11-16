# Direct-reader validation

Run from `connectors/slack/direct`:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -p 'test_*.py'
```

Tests construct synthetic V8 values, LevelDB records, snapshots and temporary SQLite ledgers. They exercise malformed inputs, bounded decoding, private selection, reconciliation, durable replay and path validation without reading a real application cache.

No captured account inventories or host measurements are distributed. For installed-runtime checks see ../VALIDATION.md.
