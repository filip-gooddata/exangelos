# Slack connector

Watches delayed, persisted Slack desktop snapshots for new messages, replies, edits,
and reaction additions/removals in privately selected conversations. The owner has
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

The official process can start and handshake on machines without Slack, Python or
configuration. It does not launch Python or inspect Slack data before Configure.
Describe before configuration returns a sanitized invalid-parameters response.
Configure with missing runtime or app data returns a sanitized rejection while the
process remains available. Watches require successful configuration.

All installed files are immutable. Production subprocesses disable Python bytecode
writes; SQLite state belongs in the external data directory described below. Do not
point `EXANGELOS_HOME` or `XDG_DATA_HOME` inside the installed connector: reconciliation
rejects a ledger path there. Back up that external ledger with subscription cursors.

## Configuration and portable setup

Configure `sourceMode=persisted-cache` and supply one secret selector. Use
`conversationId` for a Slack conversation ID, an HTTPS Slack workspace
`/archives/<conversation>` link (optionally ending in a message permalink), or
an `https://app.slack.com/client/<workspace>/<conversation>` link. Client links
also constrain the workspace ID. Archives links select by conversation ID.
Alternatively, use `conversationSnippet` for literal text in a cached message.
This explicitly authorizes discovery across cached messages in the configured roots,
then continued use of the uniquely matching **persisted** account and conversation,
even after logout, account switching, or access changes. It does not establish current
sign-in or permission. Do not choose this mode if current authenticated access is required.
The connector has no live authority adapter and never extracts tokens or sessions.

During Configure only, the connector detects the current user's macOS home and tries
Slack's standard `Library/Application Support/Slack/IndexedDB` and App Store sandbox
`Library/Containers/com.tinyspeck.slackmacgap/Data/Library/Application Support/Slack/IndexedDB`
locations. It derives workspace, account and conversation IDs from validated persisted
records. It rejects multiple matching roots/accounts/conversations, unreadable or
changing discovered roots, unsupported data, and incomplete selections. No arbitrary
first-account choice is made. A distinctive snippet narrows conversation selection;
`cacheRoot` can explicitly narrow discovery to one source. Names and IDs are not returned
in public errors, Describe responses, events or cursors.

| Field | Setup use |
| --- | --- |
| `sourceMode` | Required for new setup: choose `persisted-cache` to authorize cached discovery and use; sign-in remains unverified. |
| `conversationSnippet` | Literal snippet in a persisted message. |
| `conversationId` | Alternative secret selector for an ID or supported conversation link. |
| `cacheRoot` | Optional fallback: absolute IndexedDB folder for a custom installation or supported-format copied snapshot; otherwise macOS locations are detected. |
| `selectionRevision` | Optional, default `1`: change deliberately to rediscover/reset a selection; use a new subscription without an old cursor. |
| `pollIntervalMs` | Optional, default `30000`, range `1000`–`3600000`; controls polling, not freshness. |
| `privateSource` | Legacy fallback only: existing private selection/key JSON; cannot be mixed with new setup fields. |

Fields are catalogue-optional so any invalid Configure reaches the handler and clears
prior in-memory configuration. Initial setup requires source mode and one selector.
The SDK has static Choice/Text/Secret fields and Accepted/Rejected Configure responses,
but no dynamic discovery picker or custom setup tool. Thus selection is through a secret
configuration field; no external bootstrap script or manually authored private JSON is
needed. Use the host's secret-field input (`--secret-file` or `--secret-command` for CLI
users); never put snippets in command arguments, subscription parameters or logs.

Setup generates a stable random key and stores a pinned source/account/conversation in
`$EXANGELOS_HOME/connector-state/slack/setup.json`, or under
`${XDG_DATA_HOME:-~/.local/share}/exangelos/connector-state/slack/setup.json`.
Existing external state in the older `connectors/slack` directory is reused when it holds a pin or ledger and has no connector manifest.
Before installing over legacy state, stop the daemon and back up the whole legacy state directory. If it contains only private Slack state and the new location is absent, move the entire directory to `connector-state/slack` under the same data home. This preserves the pin, ledger and SQLite sidecars together. The updated installer refuses to replace a Slack directory containing private state.
This connector-managed private file is external to the installation, mode 0600, with a
mode-0700 containing directory. The snippet is represented there only by a keyed digest;
the host retains supplied secret fields when omitted from configuration updates.
Use the CLI's secret-input flags for the mode and revision fields as well. For example:

```sh
exangelos connector configure slack --secret-command 'sourceMode=echo persisted-cache' --secret-file conversationSnippet=/path/to/snippet
exangelos connector configure slack --secret-command 'sourceMode=echo pinned-cache'
```

The second command retains the pin and drops the stored selector.
Changing mode clears the host's stored connector secrets. The connector validates the
existing pin at the same revision and cache location. This mode cannot discover a
replacement if the pin disappears. To retry a rejected snippet with a known ID,
supply a new revision such as `--secret-command 'selectionRevision=echo 2'` and `--secret-file conversationId=<path>`
in the same Configure call. Changing revision clears the old selector before the host
stores the replacement. Back up this file with the ledger/cursors.
While setup state is retained, unchanged settings reuse the key and selection, never
silently discover a different account. The pinned expected scope is enforced by both
acquisition and Configure, including the boundary between setup and the next read. Home-relative source locations are resolved again at runtime; physical cache
replacement fails closed. To deliberately change source, snippet, or account, also change
`selectionRevision`, then start a new subscription. Missing setup state creates a new key
and old cursors fail closed; corrupt or insecure state requires repair/removal before setup.
No existing state is overwritten by failed discovery.

Support is limited to the existing macOS Slack desktop persisted IndexedDB format,
with Python 3.10+ and Bun. Default detection is macOS-only; an explicit `cacheRoot` can
read the same supported-format source on POSIX systems. This does not claim support for
other Slack cache formats, Windows runtime, complete account enumeration, or live sign-in.
The legacy [private selection bootstrap](direct/PRIVATE-SELECTION.md) remains available
for existing installations only. Changing a legacy key/selection also requires a fresh
subscription. Subscription parameters remain `selection=selected`.

## Source and reconciliation

Effect 4.1.4's ChildProcessSpawner invokes `python3 direct/source.py` with one JSON
request on stdin, using the configuration shape above. The response is private keyed
JSON: `{scope, complete: true, messages, generation, snapshot}`. Each message contains
`{id, body, reply, reactions, reactionsComplete}`. Markers are 64 lowercase hex
characters; generation is a decimal string. Output is bounded to 4 MB and acquisition
to 45 seconds. These connector limits are deliberately tighter than the Python
reader's 10,000-message/8 MiB limits; oversized selections fail closed. Stderr and error details are suppressed; expected failures have fixed
sanitized reasons. No external requests, authentication extraction or app mutation.
Ship `direct/source.py`, `direct/ledger.py` and the vendored/runtime files alongside the entry point;
the compiled JS build alone does not bundle Python files.

The first Watch snapshot establishes a silent baseline. Only the last event in a
batch carries its cursor; an empty changed batch emits a cursor item. Event payloads
contain only `count: 1`, with generic summaries and no message bodies or links.
Reconciliation owns stale/backwards snapshot handling and reaction coverage on both
sides of a comparison. Missing messages do not imply deletion, and missing reaction
coverage does not imply removal. Bounds are 500 messages per observed snapshot and 100 reactions per message.
Restart requires the same key, selection, saved cursor and local ledger.

Reconciliation uses Python's standard-library SQLite runtime. The ledger lives at
`$EXANGELOS_HOME/connector-state/slack/ledger.sqlite3`, or otherwise at
`${XDG_DATA_HOME:-~/.local/share}/exangelos/connector-state/slack/ledger.sqlite3`.
It persists only keyed message/body/reaction markers, coverage flags, revisions,
scope and generation metadata, and immutable event batches. No message bodies,
credentials or content-bearing event payloads are stored. The cursor is a bounded
opaque version-4 handle, not the message inventory. Existing version-3 cursors are
unsupported and fail explicitly; starting without a cursor establishes a new silent
baseline, even when another subscription already watches the same scope.

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
or live event latency. The parent owns combined Python/reconciliation integration and
the full repository suite. Historical validation is recorded in [VALIDATION.md](VALIDATION.md).

After the Python source is integrated, run this aggregate-only SDK acquisition check
from `connectors/slack`, with `PRIVATE_SOURCE_FILE` set to the private JSON file path.
It reads the real source twice (Configure and the first Watch baseline); it does not
print protocol responses, markers, paths, message content or exception details:

```sh
PRIVATE_SOURCE_FILE=/absolute/path/to/private-source.json bun --eval '
import { readFileSync } from "node:fs";
import { BunChildProcessSpawner, BunFileSystem, BunPath } from "@effect/platform-bun";
import { Effect, Layer, Stream } from "effect";
import { ConnectorTest } from "@exangelos/connector-sdk";
import { connector } from "./src/Slack.ts";
const program = Effect.gen(function*() {
  const privateSource = yield* Effect.try(() => readFileSync(process.env.PRIVATE_SOURCE_FILE, "utf8"));
  const client = yield* ConnectorTest.makeClient(connector);
  const configured = yield* client.Configure({ values: { privateSource } });
  if (configured._tag !== "Accepted") throw new Error("unavailable");
  const described = yield* client.Describe({ parameters: { selection: "selected" } });
  const items = yield* client.Watch({ parameters: { selection: "selected" }, eventTypes: [] }).pipe(Stream.take(1), Stream.runCollect);
  return { configured: true, described: described._tag === "Described", baselineCursor: items.length === 1 && items[0]._tag === "Cursor" };
}).pipe(Effect.scoped, Effect.provide(BunChildProcessSpawner.layer.pipe(Layer.provide(Layer.merge(BunFileSystem.layer, BunPath.layer)))));
try { console.log(JSON.stringify(await Effect.runPromise(program))); }
catch { console.log(JSON.stringify({ acquisition: false })); process.exitCode = 1; }
'
```

A successful baseline validates acquisition only. It proves neither a live mutation
nor bounded latency, atomicity, or complete message/reaction coverage.
