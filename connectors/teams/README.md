# Teams connector

Watch a conversation by its Teams ID, or watch a verified channel thread by its message link. One connector configuration can serve multiple subscriptions. The data comes from a local desktop cache, so delivery depends on what Teams has persisted.

## Configure and subscribe

The following commands use synthetic identifiers. Use **Copy link** on the intended Teams message to obtain your own reference. A chat ID is the conversation component of that link.

```sh
exangelos connector configure teams subscriptionAccess=persisted-cache messagePreviews=disabled
exangelos subscribe teams '19:example@thread.v2' --intent "Follow the planning chat" --pull-only
exangelos subscribe teams 'https://teams.microsoft.com/l/message/19:example@thread.tacv2/1700000000000?parentMessageId=1700000000000' scope=replies --intent "Follow replies to the release post" --target t3:example-session
```

The first subscription collects events for the CLI. The second wakes a T3 session. Replace the example session with your intended target.

For a message reference, use `scope=conversation` to watch the whole conversation or `scope=replies` to select its verified reply thread. A bare message ID needs its conversation to identify it. Use the copied Teams link. A quoted message in a chat does not establish a thread. A replies subscription excludes the root post itself. In structured calls, pass the positional reference as `parameters.selection` and the scope as `parameters.scope`. Microsoft documents the underlying link forms. [Teams deep links](https://learn.microsoft.com/en-us/microsoftteams/platform/concepts/build-and-test/deep-link-teams)

Handshake and Configure run without reading Teams. Setting `subscriptionAccess=persisted-cache` allows Describe and Watch to read the cache and report the selected conversation, available author, times and link. Cache contents may remain available after logout or changes in access. The connector does not verify current sign-in or server permissions.

On macOS the connector discovers supported native Teams IndexedDB caches. For a nonstandard location or to narrow an ambiguous match, include `cachePath=/absolute/path/to/teams.leveldb` when configuring. An explicit path selects one physical cache. When multiple cached accounts share that directory, configure `account=TENANT_GUID/USER_GUID` to select one account partition. The saved subscription pins the resolved conversation and account partition. If the reference is ambiguous or unsupported, verify the original reference, cache location and intended account. Subscribe again if the pinned cache or account has changed.

A well-formed channel or chat ID can start waiting in an unambiguous account before its conversation appears. For a replies link with an unseen message, the connector preserves an explicit parent ID and waits for the selected message to confirm a distinct parent. The same parent check applies to a whole-conversation watch started from a message link. Without one, the exact message can identify its containing thread when it appears. The watch retains the verified thread across restarts and message eviction. Older subscriptions keep their saved handles. When an older release saved only the root, the original reply link may need a new observation to identify that same thread. An explicit parent conflict ends the watch and asks for the thread link. A matching reply can establish visibility on its own. A group ID in the link remains a constraint on the watch. Equivalent links inherit the same group constraint. An unknown group keeps the watch waiting. If Teams identifies a different group later, the watch ends without delivering its messages.

Show and List indicate when the selection is waiting. The first visible batch includes eligible messages whose original arrival time is equal to or later than subscription creation. Both times use integer epoch milliseconds. Finer message timestamps are rounded down. An edit or observation timestamp cannot supply a missing original time. An unobserved message, or one with no supported original time, can be missed. On older daemons that omit the creation time, the connector uses the beginning of the first Watch that saves a checkpoint, so earlier arrivals can be missed.

The watch ends after two accumulated hours of observing an absent selection. Each interval between consecutive successful reads counts up to the current polling interval (one to five seconds). A gap more than five seconds over that interval counts zero. Reopening preserves accumulated time and starts a fresh pair of reads. A read failure is reported separately. The connector processes a selection that appears on the expiry poll.

## Events and previews

Wakes report new messages, channel replies, edits and reaction membership changes. An author identifies the sender of the original message. For edits and reactions the actor may be unknown. Each event has an observation time. Where available the wake also includes the original message time and a scoped Teams link. Display names and other cache-supplied text are untrusted.

Message text is off by default. Set `subscriptionAccess=persisted-cache messagePreviews=enabled` to share up to 160 Unicode code points from new messages, replies and edits in the selected scope. In a wake, the single-line text follows `Untrusted message excerpt:` as a JSON-quoted string. The same excerpt can reach event history, desktop alerts, debug payload logs and committed replay batches. Reaction events omit it.

The connector reads the message body. For supported rich text it uses text in supported formatting elements and link labels. Ordinary classes and simple inline color, weight and italic styling can retain text. Explicit hidden attributes, recognized hiding classes and unsupported inline styles suppress their subtrees. Visibility is inferred from the cached markup. Link destinations, attributes, quoted reply blocks, cards, files and other metadata do not supply excerpt text. It skips unsupported or hidden markup and omits rich text with unbalanced elements or stylesheets. Hidden, deleted and redacted messages also omit the excerpt. It folds whitespace and nonprintable characters. Before clipping, it replaces exact values of inherited environment variables whose names contain token, key, secret, password, auth or cookie (case-insensitive) with `[redacted]`. Other visible content can include confidential information, credential-like strings and instructions.

Upgrading from 0.2.0 keeps existing preview settings and subscriptions. Enabled subscriptions can start receiving previously screened content in new events. Disabled subscriptions stay off. To turn previews off, configure `subscriptionAccess=persisted-cache messagePreviews=disabled` and start a fresh subscription baseline. Committed batches replay as originally recorded under their original policy, and changing settings does not erase previously delivered or stored excerpts.

## Start, resume and upgrade

A new watch records history for older messages. The ledger compares original arrival time with the watch cutoff for previously unseen rows, including the first visible batch. It suppresses rows that predate the watch and rows whose age is unknown. Independent watches have independent cursors. The ledger commits each batch before delivery and retains its original summary, payload, timestamps, ordering and deduplication keys for replay. Only the final event carries the advanced cursor. Keep the private state and ledger together when restarting.

After upgrading from 0.1, configure the new access setting explicitly and create each subscription again using its original intended conversation ID or link. Old selections and cursors cannot identify the new account, scope and consent contract. They fail closed. Keep any historical events you need in the host. Use a fresh subscription to establish a new baseline.

## Runtime and limits

The connector requires Python 3.9+ with SQLite, resource and fcntl on a compatible Unix host. Native discovery targets macOS. A compatible cache copy can be supplied on another Unix host. The cache decoder supports a bounded subset of persisted IndexedDB, LevelDB and Teams record formats. Channel and account variants are tested against synthetic records. Externally stored IndexedDB blob values cannot be decoded. If acquisition encounters one in the selected store, it refuses the snapshot. Personal bot aliases, draft chats, and references without a readable account partition are unsupported. A group-qualified link requires a matching group before the connector can deliver events. Application upgrades, cache eviction, concurrent writes and changes entirely between polls can cause observation gaps. Deletion of a cached row never implies a message was deleted on the server.

Private state is kept under `$EXANGELOS_HOME/connector-state/teams`, or `$XDG_DATA_HOME/exangelos/connector-state/teams` (default `~/.local/share/exangelos/connector-state/teams`). It includes the scope bindings, SQLite history and committed replay batches. With previews enabled the replay batches can contain excerpts. Version 0.3.4 continues to use a previous external state directory containing a pin key or ledger when the new location is absent. Before installing over a state-only `connectors/teams` directory, stop the daemon and move that whole private directory to `connector-state/teams` if the destination is absent. Keep the pins, key and ledger together to resume existing subscriptions. Ledger retention grows with subscriptions and events.

See the [installed validation instructions](https://github.com/filip-gooddata/exangelos/blob/main/connectors/teams/scripts/README.md) for synthetic checks and the [decoder provenance](https://github.com/filip-gooddata/exangelos/blob/main/connectors/teams/validation/PROVENANCE.md) for format references.

## Connector icon

On macOS and Linux, a failed cache inspection saves the latest failure in `diagnostics/teams/last-error.json` under the Exangelos data directory. The service default is `~/.local/share/exangelos`. The owner-only file survives successful polls and connector updates. It records the operation, time, process outcome and, when available, the exception class and source coordinates. The connector keeps these details local. When the adapter receives a bridge or process deadline at least 90 seconds after a read-only poll began, it checks that the original authorization still applies before making one fresh attempt.

On macOS the connector reads the icon from the installed Microsoft Teams app bundle without opening the app. It looks for the current Teams app first, then classic Teams. It converts the icon in memory and serves a 128 × 128 PNG to the panel. If the icon is unavailable, the panel shows initials.

The connector ships without vendor artwork. The Teams icon is a trademark of Microsoft. Displaying it from a local installation still carries trademark risk and does not imply endorsement.
