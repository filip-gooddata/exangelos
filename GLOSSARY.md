# Exangelos

Exangelos lets AI coding agents subscribe to events from outside systems and wakes the right agent session when one arrives. One person runs it on one machine and supervises it.

## Language

### Sources

**Connector**:
An installed package that watches one kind of external source and reports events.
_Avoid_: Source, integration, plugin, provider

**Catalogue**:
What a connector declares: its event types, its subscription parameters and its configuration fields.
_Avoid_: Schema, manifest, capabilities

**Event type**:
A named kind of event in a catalogue, such as `checks.failed`.
_Avoid_: Trigger, topic, hook

**Subject**:
The one thing a subscription watches, such as `acme/app#123`, named by the connector from the subscription's parameters.
_Avoid_: Target, resource, entity

**Trust**:
Whether a connector may run: inert, enabled, or dev.
_Avoid_: Status, permission

**Inert**:
A connector that is installed and not allowed to run until you enable it.
_Avoid_: Disabled, untrusted, pending

**Available**:
A connector that is enabled or dev, has its configuration set and has a running process.
_Avoid_: Healthy, ready, online

### Subscriptions

**Subscription**:
A standing request to be told about selected event types on one subject.
_Avoid_: Watch, watcher, listener, monitor

**Intent**:
The agent's one-line statement of why it subscribed, required when subscribing and written for you.
_Avoid_: Note, description, reason, comment

**Event**:
One occurrence a connector reported for a subscription.
_Avoid_: Message, update, notification

**Pending**:
An event that no one has acknowledged yet.
_Avoid_: Unread, unseen, new

**Acknowledge**:
To declare every event of a subscription up to a given number as dealt with.
_Avoid_: Dismiss, mark read, consume

**Backlog**:
The pending events of one subscription.
_Avoid_: Queue, inbox

**Cursor**:
The connector's bookmark for a subscription, from which watching continues after any interruption.
_Avoid_: Checkpoint, offset, state

**Active**:
An open subscription that is watched.
_Avoid_: Running, live

**Suspended**:
An active subscription whose connector is unavailable; it continues by itself when the connector returns.
_Avoid_: Paused, stalled, blocked

**Waiting**:
An active subscription whose subject is not readable yet, such as a conversation not yet in a local cache; the connector reports it with a Pending watch item. Healthy, unlike failing.
_Avoid_: Pending (pending means events not yet acknowledged)

**Failing**:
An active subscription whose connector runs but cannot read its subject, retrying until a read succeeds again. Its session gets one wake once it has failed for five minutes, at most one an hour, and one more when it recovers.
_Avoid_: Suspended, degraded, broken, erroring

**Paused**:
An open subscription that is not watched, because its backlog hit the limit or an actor paused it.
_Avoid_: Suspended, stopped

**Expired**:
An open subscription that is not watched because its expiry time passed.
_Avoid_: Timed out, stale

**Ended**:
A closed subscription that finished because the connector ended it or it reached its number of events.
_Avoid_: Completed, done

**Cancelled**:
A closed subscription that an actor stopped.
_Avoid_: Deleted, removed

### Delivery

**Harness**:
A program that runs agent sessions and can deliver a message into one, such as T3 Code, Claude Code or Codex, or a command you define in settings that delivers it.
_Avoid_: Client, host, agent runner

**Session**:
One agent conversation inside a harness.
_Avoid_: Thread, conversation, agent

**Wake target**:
The session a subscription wakes; a subscription has one, or none when it is pull-only.
_Avoid_: Recipient, destination, subscriber

**Pull-only**:
A subscription with no wake target, whose events an agent collects by asking.
_Avoid_: Silent, passive, polling

**Wake**:
A message the daemon sends to a wake target, pointing at the stored events.
_Avoid_: Notification, nudge, ping, alert

**Wake window**:
How long the daemon gathers a subscription's events after the first one before it sends one wake. Each Watch carries it to the connector, which gathers a source's changes into one event over the same span.
_Avoid_: Debounce, settle interval

**Alert**:
A desktop notification for you, sent only when something needs you.
_Avoid_: Wake, notification, warning

**Event alert**:
An alert for each new event of a subscription. Off unless you turn it on globally or for one subscription; the session that created a subscription may also switch it for that subscription.
_Avoid_: Event notification

### People and agents

**Actor**:
Who made a change to a subscription or connector: a session, or you.
_Avoid_: User, caller, author

**You**:
The one person who runs Exangelos on their machine and supervises it.
_Avoid_: User, admin, operator, human
