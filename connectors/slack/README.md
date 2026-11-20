# Slack connector

Watches delayed, persisted Slack desktop snapshots for new messages, replies, edits,
and reaction additions/removals in selected conversations and threads. The owner has
accepted this delayed mode and waived the previous <=60-second requirement.

Staleness is unbounded. Polling more often cannot reveal unpersisted changes.
Intermediate messages, edits, replies and reaction toggles can be missed. Events
describe differences between observed snapshots, not a complete history. Their
occurrence time is the observation time, not the original Slack action time.
See the [persisted state contract](direct/redux-producer-report.md) and
[evidence boundaries](direct/evidence.md).

## Installation prerequisites

The release archive includes `dist/main.js` and the explicitly listed Python
runtime and vendor licenses in `connector.json`. It requires Python 3.10 or newer
available as `python3`, with standard-library SQLite support, to configure and watch.
The supported source is Slack desktop's local macOS IndexedDB snapshot; Slack must
have persisted a supported snapshot for the selected conversations. No network
access, Slack token or session extraction is used.

Startup, Handshake and Configure need neither Python nor a Slack cache. The connector
first opens the cache when resolving an authorized subscription. Installed files are
immutable. Back up the external state directory with subscription cursors.

## Subscribe to a conversation or thread

On first use, Subscribe installs the official connector. Authorize cache access once,
then repeat Subscribe with your subject:

```sh
exangelos connector configure slack subscriptionAccess=persisted-cache
exangelos subscribe slack D0000002 --intent 'Watch this conversation' --pull-only
```

Use a D, C or G conversation ID to watch the conversation. To identify a message,
supply a quoted HTTPS Slack message permalink, an exact timestamp such as
`1700000000.000001`, or `C0000001:1700000000.000001`. Keep timestamps as strings,
including all fractional digits. For example,
`https://fixture.slack.com/archives/C0000001/p1700000000000002?thread_ts=1700000000.000001&cid=C0000001`
identifies a reply. Its workspace domain must match the cached workspace metadata.
If the cache lacks that metadata, use `CHANNEL:TIMESTAMP`. A reply selects its
containing thread by default.
A top-level message needs an explicit choice:

```sh
exangelos subscribe slack C0000001:1700000000.000001 scope=conversation --intent 'Watch the conversation' --pull-only
exangelos subscribe slack C0000001:1700000000.000001 scope=replies --intent 'Watch replies to this message' --pull-only
```

For the MCP `subscribe` tool, pass the same reference as `parameters.selection`.
For example, use the following arguments, changing `replies` to `conversation`
to receive events across the conversation:

```json
{"connector":"slack","parameters":{"selection":"C0000001:1700000000.000001","scope":"replies"},"intent":"Watch replies to this message","pullOnly":true}
```

The shell, process arguments and requesting host can see the supplied ID or link.
The host receives a display label based on available same-account cache metadata,
and stores an opaque scope handle. Events share message timestamps, scoped Slack links,
and available sender names or IDs with the host. Labels may identify a DM peer or channel.
When names are unavailable, a conversation or known peer ID identifies the subject.
A thread label adds the parent timestamp.
Message bodies, credentials and other participants' messages are excluded from
labels and events. Each subscription pins its own source, account, conversation
and optional thread. Multiple scopes can run concurrently.

Cache access includes persisted data retained after logout or permission changes.
The cache cannot establish current sign-in. Revoke access with
`exangelos connector configure slack subscriptionAccess=disabled`. The default
macOS search checks the standard Slack desktop and App Store sandbox IndexedDB
directories. For copied caches or nonstandard installations set `cacheRoot` to
an absolute IndexedDB directory on a supported POSIX system. An existing
`subscriptionCacheRoot` overrides it. Use a more specific reference or narrow
the root if matches span multiple accounts, conversations or cache directories.
`pollIntervalMs` defaults to 30000 and accepts integers from 1000 through 3600000.

## Upgrading existing subscriptions

Configuration no longer selects a conversation. Authorize positional access and
create a subscription with the original ID or message reference when a legacy
selection or handle is rejected. The connector leaves old private state in place.
Keep the private pins, keys, ledger and SQLite sidecars together in
`$EXANGELOS_HOME/connector-state/slack` (or
`${XDG_DATA_HOME:-~/.local/share}/exangelos/connector-state/slack`).
If private state occupies the old install directory `connectors/slack`, the installer
refuses to replace it. Stop the daemon, back up the directory, and move the entire
private state directory to `connector-state/slack` if that destination is absent.

## Source and reconciliation

Effect 4.1.4's ChildProcessSpawner invokes `python3 direct/source.py` with one JSON
request on stdin, using the configuration shape above. The response is private
JSON: `{scope, complete: true, messages, generation, snapshot}`. Each message contains
`{id, body, reply, reactions, reactionsComplete, messageTs, conversationLabel, permalink}`
and an optional `sender`. Markers are 64 lowercase hex
characters; generation is a decimal string. Output is bounded to 5 MB and acquisition
to 45 seconds. These connector limits are deliberately tighter than the Python
reader's 10,000-message/8 MiB limits; oversized selections fail closed. Stderr and error details are suppressed; expected failures have fixed
sanitized reasons. No external requests, authentication extraction or app mutation.
Ship `direct/source.py`, `direct/ledger.py` and the vendored/runtime files alongside the entry point;
the compiled JS build alone does not bundle Python files.

The first Watch snapshot establishes a silent baseline. Only the last event in a
batch carries its cursor; an empty changed batch emits a cursor item. Event payloads
carry `version: 1`, `count: 1`, the exact Slack timestamp string (`messageTs`),
a `conversationLabel` and a `permalink`. Replies include their parent timestamp
in the link. When the workspace domain is unavailable, the link uses the workspace
and conversation IDs. The optional `sender` identifies the message author, including
on reaction events. Older committed batches replay their original count-only payload.
Reconciliation owns stale/backwards snapshot handling and reaction coverage on both
sides of a comparison. Missing messages do not imply deletion, and missing reaction
coverage does not imply removal. Bounds are 500 messages per observed snapshot and 100 reactions per message.
Restart requires the same key, selection, saved cursor and local ledger.

Reconciliation uses Python's standard-library SQLite runtime. The ledger lives at
`$EXANGELOS_HOME/connector-state/slack/ledger.sqlite3`, or otherwise at
`${XDG_DATA_HOME:-~/.local/share}/exangelos/connector-state/slack/ledger.sqlite3`.
It stores keyed message/body/reaction markers, delivery context, coverage flags,
revisions, scope and generation metadata, and immutable event batches.
Message bodies and credentials are excluded. The cursor is a bounded
opaque version-4 handle, not the message inventory. Existing version-3 cursors are
unsupported and fail explicitly; starting without a cursor establishes a new silent
baseline, even when another subscription already watches the same scope.

Slack 0.3.0 stores the local clock time just before the first snapshot read for
each new Watch lineage. A previously unseen message or reply qualifies as an
arrival when its Slack timestamp is at or after that start. Older rows entering
the cache are remembered silently. A later poll can deliver several qualifying
messages, including a message that only became visible after a newer one. This
comparison assumes the local machine clock agrees with Slack. The first snapshot
itself remains silent, and messages that never reach the cache cannot be reported.

A cursor created before 0.3.0 can replay its already committed batches with
their original payloads. Its ledger has no recorded Watch start. At the end of that history the connector ends the old Watch with a reason
visible in `exangelos show`. If the old subscription is paused with an unread
backlog, leave it paused and inspect it with `exangelos --json events OLD_ID`.
After upgrading, subscribe again with the same selection, scope, event types,
intent and delivery settings. If the CLI reports a similar open subscription,
repeat that command with `--similar-ok OLD_ID` (or the IDs it reports). The
replacement establishes a fresh baseline. This procedure keeps the old backlog
available without acknowledging it. Resume alone cannot clear a backlog at
the host limit or supply the missing Watch start.

The 500-message limit applies to each source snapshot, never to lifetime history.
Disappearing messages remain remembered; returning unchanged messages are silent.
Each subscription has an independent lineage. A transaction commits the next batch
and its metadata, including the original observation timestamp, before delivery. Restarting from its input cursor replays the same
batch and dedupe keys, even if the next source snapshot changed; subsequent polling
from the returned cursor reconciles that snapshot. Only the last event carries the
new cursor. Yielding an event is not durable acknowledgement, so nothing is pruned
on yield. Missing or corrupt referenced state fails explicitly instead of resetting.
Keep the ledger with daemon cursor backups. Disk use grows with retained message
metadata and transitions; there is no automatic pruning or lifetime ceiling.


## Validation

```sh
pnpm --filter @exangelos/connector-slack test
pnpm --filter @exangelos/connector-slack typecheck
python3 -m unittest discover -s connectors/slack/direct -p 'test_*.py'
```

The real-Python ledger contract tests use synthetic snapshots and isolated temporary storage.
They cover 500-to-499-plus-new turnover, historical return, immutable replay and
independent baselines. SDK tests stop and resume at every partial batch boundary
while a newer snapshot is available. They also exercise Configure, Describe, silent baseline, cursor delivery, resume,
filtering, polling cancellation and sanitized errors. Source tests replace the process
service and exercise stdin and output handling. They do not prove actual acquisition
or live event latency. Installed-archive checks are documented in [VALIDATION.md](VALIDATION.md).
