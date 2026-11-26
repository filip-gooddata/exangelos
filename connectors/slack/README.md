# Slack connector

Watches delayed, persisted Slack desktop snapshots for new messages, replies, edits,
and reaction additions/removals in selected conversations and threads. Optional
notification-log access can detect a post or reply and trigger an immediate cache check.

Staleness is unbounded. Polling more often cannot reveal unpersisted changes.
Intermediate messages, edits, replies and reaction toggles can be missed. Cache events
describe differences between observed snapshots. Their
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

An unseen conversation ID or channel-qualified message can be selected when one verified
local workspace and account match. A bare timestamp needs a matching message to identify
its channel. For an unseen message, choose the conversation or its replies explicitly.
A qualified message ID can start waiting before its parent is known. Once the
exact message identifies its containing thread, the watch retains that binding across
restarts and message eviction. When a permalink names a different message as the parent, the watch waits for
the selected message to confirm that relationship, including when the watch covers the whole conversation. If the message contradicts that parent, the watch ends and asks for the thread link. Show and List mark the watch as waiting.

A saved watch keeps its handle after an upgrade. If an older release saved only the thread root,
a link to an evicted reply needs a fresh observation to identify the same thread again.

The first matching snapshot can deliver replies even if the root is absent. Slack's original
message timestamp is compared as decimal seconds, retaining up to ten fractional digits.
A timestamp equal to or later than the daemon's subscription creation time (milliseconds)
is eligible. Earlier messages establish history silently. The usual filters, author, link
and opted-in excerpt requirements still apply. Messages that never appear in a readable
snapshot can be missed. Older daemons supply no creation time. In that case the cutoff is
the start of the first Watch that successfully saves a checkpoint. Earlier arrivals can be missed.

A missing selection expires after two hours of successful observation. While waiting, each
interval between consecutive successful reads contributes up to one poll interval (at most
30 seconds). Gaps more than five seconds over that interval contribute nothing. Reopening
starts a new pair of observations and retains accumulated time. A read error is reported
separately. A selection visible on the expiry poll is processed normally.

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
Each subscription pins its own source, account, conversation and optional
thread. Multiple scopes can run concurrently.

### Wake summaries and message previews

Starting with Slack 0.4.0, new events identify the change, the conversation,
the original message's author when available, and its Slack timestamp in UTC.
Edit and reaction summaries label the original message author and also give
the UTC time at which the connector observed the change.
The connector uses account-scoped names when available, falling back to a
cached ID or “unknown author”. A timestamp outside the calendar range appears
as the original Slack timestamp. Within each new batch the connector orders events
by the full numeric Slack message timestamp. Changes to one message keep their
edit and reaction sequence. Previously committed batches keep their
original event identities on replay. Exangelos 0.1.9 shows only the
end notice when an event reaches a subscription cap (including `--once`).
The event remains available through `exangelos events`. Showing the pending
event line in that end notice requires the updated host wake renderer.

Message previews are off by default, including for existing cache grants.
On an already configured install, enable previews with:

```sh
exangelos connector configure slack messagePreviews=enabled
```

Disable previews for future events with:

```sh
exangelos connector configure slack messagePreviews=disabled
```

This connector-wide setting applies to new messages, replies and edits in
each authorized selection. It preserves subscriptions and cursors. When
enabled, eligible events carry an optional `preview` in their payload and a
quoted, single-line excerpt in their wake summary. Treat the excerpt and
display names as untrusted Slack data. The excerpt can appear in event
history, the receiving agent session, desktop alerts, and debug-level
event payload logs. The private ledger retains committed excerpts for replay. Starting with 0.5.1, the connector omits excerpts from
replayed payloads and summaries while previews are disabled. Previously delivered
host history and agent sessions can still contain them. With the accompanying host
update, disabling previews also omits excerpts from unacknowledged backlog lines
in subsequent wakes and waits. Exangelos 0.1.19 can repeat previously delivered
summaries until those events are acknowledged.

An upgrade preserves the current choice. Existing enabled installations immediately
share the broader range of visible text for new deliveries. Existing disabled
or unconfigured installations keep previews off. Changing the setting does
not rewrite previously committed events.

A file-only post or reply says the sender shared a file and links to the
message. With previews enabled, visible filenames form the untrusted excerpt.
A verified share can arrive even when its filename is unavailable. The
connector uses cached display metadata and never opens the shared files.
With the accompanying host update, disabling previews hides previously
committed file-share excerpts in `events` and `show`, as well as in wakes
and `wait`. The original stored event and its identity are preserved.

New file-only observations treat blank fallback text as one body identity.
On upgrade, 0.6.2 recognizes an old empty or single-space fallback, or the
same whitespace still present in the cache. If a different whitespace-only
fallback changed before the first upgraded read, the old keyed body marker
can be indistinguishable from a changed caption and may produce an edit.

The connector prefers visible block and attachment text to a notification
fallback. Scoped app and bot messages can omit that fallback when their
layout contains supported visible text. An absent or undefined fallback uses
the same body marker as an empty string. Slack’s edit timestamp records edits
to these messages. A layout change alone does not trigger an edit event.
It reads section fields, headers, context text, rich-text runs,
image titles, button labels and attachment titles and bodies. Labeled links
contribute their labels. Slack emphasis markers are removed from formatted text.
Code spans and plain-text fields retain their literal punctuation. An address displayed as text can appear in the
excerpt. Hidden link targets, image URLs and interactive values are excluded.
Whitespace and control characters become single-line spacing. The excerpt
is capped at 160 Unicode code points and quoted as untrusted data. Reaction
events carry metadata only.

Before clipping, exact occurrences of nonempty inherited environment values
whose variable names contain TOKEN, KEY, SECRET, PASSWORD, AUTH or COOKIE
(case-insensitive) become `[redacted]`. Overlapping matches are combined.
Credential terminology, opaque identifiers and other visible content can
appear. This does not identify every password, token or confidential detail
in a message. Host log redaction operates separately.

Cache access includes persisted data retained after logout or permission changes.
The cache cannot establish current sign-in. Revoke access with
`exangelos connector configure slack subscriptionAccess=disabled`. The default
macOS search checks the standard Slack desktop and App Store sandbox IndexedDB
directories. For copied caches or nonstandard installations set `cacheRoot` to
an absolute IndexedDB directory on a supported POSIX system. An existing
`subscriptionCacheRoot` overrides it. Use a more specific reference or narrow
the root if matches span multiple accounts, conversations or cache directories.
`pollIntervalMs` defaults to 30000 and accepts integers from 1000 through 3600000.

Run `exangelos connectors slack` to inspect current watch failures. A running
connector can have a watch that cannot read or validate its source. The daemon
logs a warning when a watch enters a failure category and retries with backoff.
A successful observation clears the warning from status, including when the
saved cursor stays the same. An unchanged cache may lag behind Slack. A
successful read establishes only that the local snapshot could be observed.

## Upgrading existing subscriptions

Slack 0.4.1 uses the filesystem volume UUID on supported macOS volumes. A
restart can change a volume's device number. When an older pin still matches,
the first successful reopen records the verified volume UUIDs and preserves
the original scope and cursor. If the device number already changed, the
older pin has no proof of the original volume. Select the conversation again
to establish a fresh baseline. Events between the old cursor and the new
baseline may be missed.

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
and optional `sender` and `preview` fields. Markers are 64 lowercase hex
characters; generation is a decimal string. Output is bounded to 5 MB and acquisition
to 45 seconds. These connector limits are deliberately tighter than the Python
reader's 10,000-message/8 MiB limits; oversized selections fail closed. Stderr and error details are suppressed; expected failures have fixed
sanitized reasons. No external requests, authentication extraction or app mutation.
Ship `direct/source.py`, `direct/ledger.py` and the vendored/runtime files alongside the entry point;
the compiled JS build alone does not bundle Python files.

The first Watch snapshot establishes history for older messages and reports eligible arrivals. Only the last event in a
batch carries its cursor; an empty changed batch emits a cursor item. Creation, edit and reaction payloads
carry `version: 1`, `count: 1`, the exact Slack timestamp string (`messageTs`),
a `conversationLabel` and a `permalink`. Replies include their parent timestamp
in the link. New arrivals wait for a workspace archive permalink. Edit and reaction events can
use a client link when the workspace domain is unavailable. The optional `sender` identifies the message author, including
on reaction events. Legacy count-only events retain their original shape.
Reconciliation owns stale/backwards snapshot handling and reaction coverage on both
sides of a comparison. Missing messages do not imply deletion, and missing reaction
coverage does not imply removal. Bounds are 500 messages per observed snapshot and 100 reactions per message.
Restart requires the same key, selection, saved cursor and local ledger.

Reconciliation uses Python's standard-library SQLite runtime. The ledger lives at
`$EXANGELOS_HOME/connector-state/slack/ledger.sqlite3`, or otherwise at
`${XDG_DATA_HOME:-~/.local/share}/exangelos/connector-state/slack/ledger.sqlite3`.
It stores keyed message/body/reaction markers, delivery context, coverage flags,
revisions, scope and generation metadata, and immutable event batches.
Baseline and version rows store a keyed body marker. Only eligible committed event batches retain opted-in excerpts. The cursor is a bounded
opaque version-4 handle, not the message inventory. Existing version-3 cursors are
unsupported and fail explicitly; starting without a cursor establishes a new silent
baseline, even when another subscription already watches the same scope.

Slack 0.3.0 stores the local clock time just before the first snapshot read for
each new Watch lineage. On a daemon that supplies subscription creation time, that time is the floor. A previously unseen message or reply qualifies as an
arrival when its Slack timestamp is at or after that start. Older rows entering
the cache are remembered silently. A later poll can deliver several qualifying
messages, including a message that only became visible after a newer one. This
comparison assumes the local machine clock agrees with Slack. In cache-only mode the first snapshot
remains silent, and delivery depends on the message reaching the cache.

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

## Connector icon

On macOS the connector reads the icon from the installed Slack app bundle without opening the app. It converts the icon in memory and serves a 128 × 128 PNG to the panel. If the icon is unavailable, the panel shows initials.

The connector ships without vendor artwork. The Slack icon is a trademark of Slack. Displaying it from a local installation still carries trademark risk and does not imply endorsement.

### Arrival delivery in 0.6.0

New posts and replies produce one counted arrival once a scoped Desktop cache
snapshot supplies the author and workspace archive permalink, plus a safe
visible excerpt when previews are enabled. A cached Slack account or bot ID can
identify the author. Metadata-only subscriptions and verified file shares without a visible filename can deliver without an excerpt.
Slack sign-in and permission to open the link are checked by Slack when opened.

With cache access configured, `notificationLog=enabled` also tails the selected
profile's `logs/default/browser.log`. The cache folder must be named `IndexedDB`.
A matching workspace, account, conversation, message timestamp and thread parent
let the connector record the arrival privately and check the cache immediately.
A new notification-enabled watch first returns its startup cursor. The daemon
saves that cursor and reopens the watch before the connector accepts hints.
Slack Desktop redacted the author, body and launch URL in sampled log records.
A notice or incomplete cache row consumes no host event, wake, backlog slot or
one-shot allowance. Edits and reaction changes observed while that arrival
is incomplete stay queued. The connector emits the actionable arrival first,
then those changes in observation order. Queued changes retain their original
observation times and omit excerpts that could belong to a later body.
Pending markers survive restarts and log rotation. The
connector checks outstanding arrivals on each configured poll, including when
the cache generation is unchanged. `notificationLog=disabled` uses cache polling
alone. Revoking cache access stops the watch.

To inspect the last observed missing fields for one subscription without waking
its target, run this against the installed 0.6.0 connector and its private ledger:

```sh
data="${EXANGELOS_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/exangelos}"
exangelos --json show "$subscription" | jq -er '.subscription.cursor' |
  python3 -B "$data/connectors/slack/direct/ledger.py" --pending
```

An empty array means there are no recorded outstanding obligations on that
lineage. Before the first upgraded reconciliation, legacy reports identify fields
the older ledger did not record. For pending arrivals, keep Slack Desktop online with access to the
selected conversation. Desktop may never persist an eligible excerpt, author,
or workspace domain, and a sleeping machine cannot deliver a wake. The reader
starts at the active log's end and skips excessive backlog. Messages missed by
both sources cannot appear in the pending report.

Existing subscriptions keep their cursor and receipt history. For an outstanding
0.5.x receipt, the first complete cache context produces one linked
`delivery: "details"` event with `count: 0` under the original event type.
The host can only deliver it to a subscription that is still active. Messages
already reconciled on earlier versions are not replayed on upgrade. Later edits
and reaction changes follow ordinary cache reconciliation.
