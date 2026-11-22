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

On macOS the connector discovers supported native Teams IndexedDB caches. For a nonstandard location or to narrow an ambiguous match, include `cachePath=/absolute/path/to/teams.leveldb` when configuring. An explicit path selects one physical cache. When multiple cached accounts share that directory, configure `account=TENANT_GUID/USER_GUID` to select one account partition. The saved subscription pins the resolved conversation and account partition. If the reference is missing, ambiguous or unsupported, verify the original reference, cache location and intended account. Subscribe again if the pinned cache or account has changed.

## Events and previews

Wakes report new messages, channel replies, edits and reaction membership changes. An author identifies the sender of the original message. For edits and reactions the actor may be unknown. Each event has an observation time. Where available the wake also includes the original message time and a scoped Teams link. Display names and other cache-supplied text are untrusted.

Message text is off by default. To include screened excerpts for new messages, replies and edits, configure `subscriptionAccess=persisted-cache messagePreviews=enabled`. Excerpts may reach agent wakes, stored event history, desktop alerts and debug payload logs. Screening is best effort, and an allowed excerpt may still contain sensitive information. Reaction events omit excerpts. To disable excerpts, configure `messagePreviews=disabled` alongside the access setting. A change in preview policy requires a fresh subscription baseline. Previously delivered or stored events remain under their original policy.

## Start, resume and upgrade

A new watch silently records its first snapshot. When previously unseen rows arrive later, the ledger compares their original creation time to the watch start. It suppresses rows that predate the watch and rows whose age is unknown. Independent watches have independent cursors. The ledger commits each batch before delivery and retains its original summary, payload, timestamps, ordering and deduplication keys for replay. Only the final event carries the advanced cursor. Keep the private state and ledger together when restarting.

After upgrading from 0.1, configure the new access setting explicitly and create each subscription again using its original intended conversation ID or link. Old selections and cursors cannot identify the new account, scope and consent contract. They fail closed. Keep any historical events you need in the host. Use a fresh subscription to establish a new baseline.

## Runtime and limits

The connector requires Python 3.9+ with SQLite, resource and fcntl on a compatible Unix host. Native discovery targets macOS. A compatible cache copy can be supplied on another Unix host. The cache decoder supports a bounded subset of persisted IndexedDB, LevelDB and Teams record formats. Channel and account variants are tested against synthetic records. Externally stored IndexedDB blob values cannot be decoded. If acquisition encounters one in the selected store, it refuses the snapshot. Personal bot aliases, draft chats, and references without a readable account partition are unsupported. A group-qualified channel link requires matching cached group metadata. Application upgrades, cache eviction, concurrent writes and changes entirely between polls can cause observation gaps. Deletion of a cached row never implies a message was deleted on the server.

Private state is kept under `$EXANGELOS_HOME/connectors/teams`, or `$XDG_DATA_HOME/exangelos/connectors/teams` (default `~/.local/share/exangelos/connectors/teams`). It includes the scope bindings, SQLite history and committed replay batches. With previews enabled the replay batches can contain excerpts. Keep this directory private and outside the installed bundle. Ledger retention grows with subscriptions and events.

See the [installed validation instructions](https://github.com/filip-gooddata/exangelos/blob/main/connectors/teams/scripts/README.md) for synthetic checks and the [decoder provenance](https://github.com/filip-gooddata/exangelos/blob/main/connectors/teams/validation/PROVENANCE.md) for format references.
