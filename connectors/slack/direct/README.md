# Direct Slack snapshot reader

The snapshot decoder supports the enabled delayed Watch adapter through
[source.py](SOURCE.md). The standalone scan remains an aggregate-only diagnostic. It reads the owner's installed Slack IndexedDB files without
opening a database for writing, copying a database, extracting credentials or
calling an account API. It requires Python 3.10+; dependencies are vendored source.

```sh
python3 connectors/slack/direct/scan.py
python3 -m unittest discover -s connectors/slack/direct -p 'test_*.py'
```

The command emits fixed aggregate counters and booleans only. Returned in-process
projection values contain private fields: never print, log, persist or send them.
`observation.snapshot(state, (workspace, owner, conversation), private_key)` selects
one conversation and returns keyed identity/body/individual reaction markers.
The key is supplied by the caller; the diagnostic generates a temporary random key
and prints no markers. It is not a persisted identity scheme for a running connector.
`compare` counts final persisted differences, not event times or intermediate events.

The reader resolves CURRENT/MANIFEST table membership and current/recovery logs,
rejects missing/skipped MANIFEST-listed tables before reconciliation,
collapses byte-identical keys by sequence (including tombstones), matches the
`reduxPersistence` database and `reduxPersistenceStore` store metadata, joins an
external record to its index-3 blob metadata, validates blob sizes, unwraps bounded
Snappy/Blink data, and projects selected V8 fields. The persisted record key must
agree with the decoded workspace/owner. Raw values remain in memory. Unknown and
credential subtrees are structurally skipped. References remain opaque, including
references to denied objects. Message bodies, timestamp identities and separately
normalized reactions are decoded only on allowlisted paths.

Reactions join by the producer's `message._rxn_key`, verified against
`message-<ts>-<channel>`. Actor counts must agree with each reaction's users. Missing
reaction state is **incomplete**, never an empty set or a removal. Hidden stubs,
missing bodies and inconsistent identities are excluded. The decoder is conservative
about references and unsupported wire tags; it does not claim a complete history.

## Capability and accepted limits

The linked persisted snapshot has been decoded live for the prior diagnostic:
scoped identities, bodies, replies, and individual reaction users. See
[evidence.md](evidence.md) for historical counts and [redux-producer-report.md](redux-producer-report.md)
for the producer trace. These reports predate the owner's delayed-mode decision.

The producer normally writes on actions after a one-hour threshold, with additional
offline/unload triggers and an idle callback without a timeout. The owner accepted
unbounded staleness and missed intermediate messages, edits and reaction toggles;
the former <=60-second requirement is waived. Polling frequency is not freshness.
The enabled runtime compares only valid selected-scope persisted observations.
Missing cache messages do not imply deletion. Reaction deltas require complete
per-message reaction coverage in both observations. Source failures preserve the
last cursor; changing the selection or database epoch requires a fresh baseline.

The [acquisition contract](SOURCE.md) describes the production command and limits.
Actual runtime acquisition and synthetic transition validation are distinct;
no diagnostic count or cached timestamp proves a live event or bounded latency.

## Limits

This is not an atomic snapshot: inventory and stat checks detect some races only. Manifest parsing
and key reconciliation are diagnostic, not a complete Chromium comparator implementation.
It currently decodes external Redux values; inline Redux values are not projected.
Limits: 32 MiB/file, 16 MiB/value or decompressed payload, 100,000 physical records,
1,000,000 projection nodes, depth 48. Incomplete/unsupported inputs remain explicit
errors; no source values or exception text are reported. File metadata is read without
modifying the running app. No synthetic input or browser dependency is used.

The vendored LevelDB/Snappy readers are reused from the prior local investigation
(MIT licenses included). Their source revisions and hashes are in
[vendor/SOURCES.md](vendor/SOURCES.md). This diagnostic does not add a shared workspace
dependency or change the connector protocol.

## Production acquisition

The owner subsequently accepted delayed persisted snapshots and waived the
60-second bound. `source.py` now provides the explicit private-selection command;
see [SOURCE.md](SOURCE.md) for stdin/output, generation ordering, limits and
coherence guarantees. The older evidence above describes the diagnostic milestone.
The command does not itself register or enable a connector.
