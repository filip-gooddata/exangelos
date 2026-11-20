# Exangelos version 1 specification

Status: draft for the owner to confirm. Terms follow GLOSSARY.md. "You" is the one person who runs Exangelos on their machine.

## Problem statement

You run several AI coding agent sessions at once, in T3 Code, Claude Code and Codex. Each session waits on things outside it: checks on a pull request, a review, a status change on a Jira issue, new files in a build folder. Today a session either polls, which wastes its context and your tokens, or it stops and relies on you to come back and tell it what changed.

The tool you use now, pr-watch, covers one case. It watches one GitHub pull request from a detached script, exits on the first trigger and wakes one T3 Code thread. It knows nothing about Jira or files, it does not keep a record of what happened between wakes, and every new kind of source would mean another script. You also have no single place to see what each session waits on, which sessions can no longer be reached, or which sources need your credentials.

## Solution

Exangelos is a daemon on your machine that agents subscribe through. An agent session subscribes to selected event types on one subject, such as the pull request `acme/app#123`, and states its intent in one line. Connectors, which are separate executables the daemon supervises, watch the sources and report events. The daemon stores every event, numbers it within its subscription and sends a wake into the session that subscribed. The wake lists the pending events and the commands to read and acknowledge them. The stored record stays the truth, and a blocking `wait` call covers a lost wake and serves subscriptions that have no wake target.

Agents reach the daemon through the `exangelos` command (alias `xng`) and through an MCP server. You reach it through a menu bar panel on macOS, a window on Linux, and the same command. The panel shows every subscription with its intent, its events, its wakes and its history, and it is where you import, enable and configure connectors. You get a desktop alert only when something needs you.

Subscriptions cannot pile up unnoticed. Each one expires after at most 7 days unless resumed, pauses when its backlog grows past 20 events or 24 hours, and tells its session once when it stops for any reason the session did not cause.

Version 1 ships five official connectors (github-pr, jira, file-watch, slack, teams) and a connector template, and it replaces pr-watch for you.

## User stories

### Agent session

1. As an agent session, I want to subscribe to a pull request's checks and reviews with one command, so that I can stop polling GitHub and continue other work.
2. As an agent session, I want the CLI and the MCP server to detect my session from the environment, so that I do not have to know or pass my own session id.
3. As an agent session nested inside a T3 Code thread, I want the T3 Code thread to be the wake target, so that the wake reaches the conversation you are watching.
4. As an agent session, I want to name a different wake target with a flag, so that I can subscribe on behalf of another session.
5. As an agent session, I want to create a pull-only subscription, so that I can collect events by asking when no wake can reach me.
6. As an agent session, I want a subscribe call with no detectable session and no flag to fail with an explanation, so that I never create a subscription that wakes nobody by accident.
7. As an agent session, I want to be required to state my intent when I subscribe, so that you can tell what each subscription is for.
8. As an agent session, I want wakes that never repeat my intent, so that my context holds only what changed.
9. As an agent session, I want show and list to return the intent, so that I can recall why a subscription exists when I ask.
10. As an agent session, I want to list the installed connectors with their catalogues, so that I can learn which event types and parameters each connector offers.
11. As an agent session, I want to select a subset of event types, so that I am woken only for what matters to my task.
12. As an agent session, I want to ask for a single event, a number of events or an end time, so that a subscription ends when my task no longer needs it.
13. As an agent session, I want the daemon to refuse a subscription that matches one I already have on the same connector and subject, and to show me the existing ones, so that I do not create duplicates by mistake.
14. As an agent session, I want to resubmit with the ids I was shown to create the second subscription anyway, so that I can have two on purpose.
15. As an agent session, I want one wake that lists every pending event after a short window, so that a burst of events reaches me as one message.
16. As an agent session, I want each wake to print the ready-made read and ack commands, so that I can act without looking up syntax.
17. As an agent session, I want to read the stored events of a subscription, so that I see payloads and links beyond the one-line summaries.
18. As an agent session, I want to acknowledge every event up to a number, so that events that arrived after the wake stay pending and cause the next wake.
19. As an agent session, I want events that stay pending to cause no further wakes by themselves, so that I am not nagged about something I chose to leave.
20. As an agent session, I want a blocking wait that returns what the wake would contain, so that I can recover from a lost wake or serve a pull-only subscription.
21. As an agent session, I want to update event types, limits, intent and parameters of a subscription, so that I can adjust it as my task changes without losing its events.
22. As an agent session, I want to pause, resume, retarget and cancel any subscription, so that I can hand work over to another session or stop watching.
23. As an agent session, I want one wake when my subscription pauses at its backlog limit, with the ack and resume commands, so that I know nothing is watched until I act.
24. As an agent session, I want one wake when my subscription expires, with the resume command, so that I can continue it if the task is still open.
25. As an agent session, I want one wake when the connector ends my subscription, such as when the pull request merges, so that I know the subject is finished.
26. As an agent session, I want one wake when another session or you pause or cancel my subscription, so that I am not left waiting on something that stopped.
27. As an agent session, I want no wake for a pause or cancel I made myself, so that I am not told what I already know.
28. As an agent session, I want one wake when the connector behind my subscription has been unavailable for an hour, so that I can tell you or plan around it.
29. As an agent session, I want resume to refuse while my backlog is over the limit and tell me to acknowledge first, so that a paused subscription does not restart into the same overflow.
30. As an agent session, I want the connector to report what changed while my subscription was paused or expired, where the source can tell, so that resuming loses as little as possible.
31. As an agent session, I want to configure a connector's secret by naming a command or a file, such as `gh auth token`, so that I can set it up without the secret entering my context.
32. As an agent session, I want the list to show my own subscriptions by default and every subscription with a flag, so that I see what concerns me first.

### You, the person at the machine

33. As you, I want a menu bar icon that opens a panel, so that I can see what every agent session waits on without opening a terminal.
34. As you, I want the icon to change when something needs me, so that I notice it without an alert for every event.
35. As you, I want every subscription in the panel with its intent, connector, subject, wake target, expiry and state, so that I can tell what each one is for and whether it still matters.
36. As you, I want to see each subscription's events, with the pending ones marked, so that I know what the agent has not dealt with.
37. As you, I want to see each subscription's wakes with state, attempt count, last error and next attempt, so that I can tell when a session is unreachable.
38. As you, I want an unreachable wake target shown as a quiet fact on the session and the waiting wake, and never as an alert, so that a closed session does not interrupt me.
39. As you, I want to see each subscription's changes with actor and time, so that I know which session or which of my own actions changed it.
40. As you, I want to acknowledge, pause, resume, retarget and cancel subscriptions from the panel, so that I can step in for an agent.
41. As you, I want a desktop alert when a connector waits to be enabled, keeps failing, has its credentials rejected, or when an official connector's checksum does not match, so that I am told only when I am needed.
42. As you, I want event alerts off unless I turn them on globally or for one subscription, so that events show in the panel and do not interrupt me.
43. As you, I want to import a connector from an archive file, an https link, a local directory or a git repository at a ref, in the panel or the CLI, so that I can add sources nobody ships officially.
44. As you, I want an imported connector to stay inert until I enable it after reading its origin and checksum, so that no code runs that I have not approved.
45. As you, I want a connector whose files change to return to inert, so that an update needs my approval again.
46. As you, I want the official connectors to download, verify and enable themselves the first time an agent needs one, so that the common case needs no setup step from me.
47. As you, I want to disable and remove connectors, so that I can stop a source I no longer trust or use.
48. As you, I want to configure a connector through a form the connector declares, with secret fields stored in the system keychain, so that I never paste a token into a config file.
49. As you, I want to see who configured a connector, so that I know whether an agent or I set its credentials.
50. As you, I want subscriptions of an unavailable connector to wait quietly and continue from their cursor when it returns, so that a crash or a credential problem loses no events that the source can still report.
51. As you, I want no agent able to import, enable, disable, remove or configure connectors through the MCP server, so that connector trust stays my decision.
52. As you, I want the daemon to start at login and keep running after I quit the panel, so that wakes reach sessions whenever they run.
53. As you, I want any CLI or MCP call that finds no daemon to start it through the right service manager, so that I never start it by hand.
54. As you, I want to see whether the daemon runs, and its version, in the panel and the CLI, so that I can tell a quiet day from a stopped daemon.
55. As you, I want settings for event alerts and default limits in the panel and the CLI, so that I can tune Exangelos without editing files.
56. As you, I want closed subscriptions and their events deleted after 30 days, so that the store does not grow without bound.
57. As you, I want an empty panel to tell me that only agents subscribe and show the command an agent runs, so that I know what to do on first launch.

### Connector author

58. As a connector author, I want a scaffold command that writes a renamed copy of the template connector, so that I start from a working package with one event type, one parameter, a configuration with a secret field and tests.
59. As a connector author, I want an SDK that turns my catalogue and my four handlers into a stdio RPC server, so that I write source logic and not protocol code.
60. As a connector author, I want to declare event payloads, subscription parameters and configuration fields as schemas, so that the daemon validates them and the panel and CLI render my configuration form.
61. As a connector author, I want to mark configuration fields as secret, so that the daemon stores them in the keychain and hands them to my process at start.
62. As a connector author, I want my Describe handler to normalise parameters and name the subject, so that duplicate detection and labels work for my source.
63. As a connector author, I want my Watch handler to stream events with dedupe keys and cursors, so that the daemon resumes my watch after any restart without duplicates.
64. As a connector author, I want to end a subscription with a reason when its subject is finished, so that agents are told and nothing is watched for nothing.
65. As a connector author, I want an in-memory test harness in the SDK, so that I test my connector without a daemon.
66. As a connector author, I want a dev link that trusts my working directory, restarts my connector when files change and labels it dev, so that I can iterate without re-importing.
67. As a connector author, I want to ship either a portable JS bundle or a native executable per platform, so that I can write a connector without bundling a runtime.
68. As a connector author, I want the daemon to refuse my connector with a clear reason when its protocol version is incompatible, so that I know to rebuild against a newer SDK.

### Someone installing the tool

69. As someone installing on a Mac desktop, I want one app download that holds the daemon binary and puts `exangelos` and `xng` on my PATH, so that one step gives me the panel, the CLI and the MCP server.
70. As someone installing on a headless Linux or macOS machine, I want a standalone binary through a Homebrew formula or an install script, so that I can run the daemon without a desktop.
71. As someone installing on Linux with a desktop, I want the same panel as a window opened from the tray, so that I get the same supervision as on macOS.
72. As someone installing, I want the daemon to run as a user service through Homebrew when Homebrew installed it, and through its own LaunchAgent or systemd user unit otherwise, so that it fits how I installed it.
73. As someone installing, I want all files under the XDG directories, with one environment variable that puts everything in a single directory, so that I can run tests or a second install side by side.
74. As someone installing, I want to register the MCP server in my harness with one command line, so that agents get the tools without extra setup.

## Implementation decisions

### Architecture

- Exangelos is open source and dogfooded by its owner. Its core knows no particular harness and no particular source. It selects, deduplicates, stores and delivers events, and connectors and wake target adapters carry everything specific.
- Exangelos is an Effect 4 application with a strict hexagonal architecture. Ports are `Context.Service` definitions. Adapters are Layers, and only the apps compose them.
- The repository is a pnpm workspace with Turborepo for tasks, Vitest with the Effect test integration, and tsgo (TypeScript 7) for type checking. Bun only runs and compiles the apps.
- Library packages are runtime-agnostic and use Effect abstractions only. The apps pick the Bun platform layers and compile with `bun build --compile` for darwin-arm64, darwin-x64, linux-arm64 and linux-x64.
- The RPC, HTTP, CLI, SQL, process and MCP modules of Effect 4 are unstable APIs, so the repository pins one exact Effect version across every package.
- The npm scope is `@exangelos`. The license is MIT.

### Packages

The four ring packages, from the inside out:

- `domain`. The records (connector, subscription, event, wake, change), their states and the transitions of the state table below, and the pure rules: backlog limit, expiry, wake content, duplicate detection, acknowledgement. It performs no I/O.
- `application`. The use cases listed below and the ports they need. It depends on `domain` only.
- `contracts`. Two Effect RPC groups with their schemas: the daemon service contract (used by the CLI, the MCP server and the panel) and the connector protocol. It also holds the wake text format and the connector manifest schema.
- `connector-sdk`. What a connector author builds on: catalogue builders, the stdio RPC server for the connector protocol, and the in-memory test harness. It depends on `contracts` only, never on `application`.

Driven adapters, one package each:

- SQLite repositories (Effect SQL client with the Bun SQLite driver).
- Secret store over the keychain gap package.
- Connector runtime: starts and supervises connector processes and speaks the connector protocol over the stdio transport gap package.
- Connector directory: discovers installed connectors by name, computes their digests and watches their files.
- Connector import sources: archive file, https link, local directory, git repository at a ref.
- Official connector source: fetches official connector archives from release files, or from a local folder when a setting points there.
- Wake targets: T3 Code, Codex, a Claude Code adapter that fails every attempt because a standalone Claude Code session has no push route in version 1, and a command adapter that runs the harnesses you define in settings.
- Alerts over the notifications gap package.
- Service manager over the service gap package.
- Settings file.
- Paths (XDG resolution and the single-directory override).
- Daemon client: the daemon's RPC transport over its unix socket. The client side serves the CLI and the MCP server and reports a distinct error when no daemon runs. The server side sets the socket's mode to 0600, removes a stale socket file and refuses to start beside a live daemon.

Gap packages that fill holes in the Effect ecosystem. Each is general-purpose, has no dependency on Exangelos packages, has its own tests, and stays private to the workspace in version 1 so it can be published later:

- Service manager: installs, starts, stops and reports a user service through launchd (LaunchAgent) or systemd (user unit), and detects a Homebrew-managed service.
- Keychain store: macOS Keychain, Secret Service on Linux, and a file with mode 0600 on headless machines.
- Child-process stdio RPC transport: an Effect RPC client protocol over a child process's stdin and stdout. Effect ships a stdio server protocol but no stdio client protocol.
- Tauri IPC RPC transport: an Effect RPC client protocol over Tauri IPC, for the panel's webview.
- Desktop notifications: macOS and Linux desktop notifications.

Apps compose layers and contain no logic of their own: `daemon`, `cli`, `mcp` and `tray`. The first three ship as one multicall binary. The `cli` app is the binary's entry point, and `exangelos daemon` and `exangelos mcp` load the `daemon` and `mcp` compositions, so each app still only composes layers.

Connectors live in the monorepo as their own packages: `github-pr`, `jira`, `file-watch`, `slack`, `teams` and `template`. None is compiled into the binary.

### Ports

| Port | Purpose | Adapters |
|---|---|---|
| ConnectorRepository | connector records: origin, digest, trust, catalogue, configuration state, process state, who configured it | SQLite |
| SubscriptionRepository | subscriptions with cursor, acked through, state, reason and changes | SQLite |
| EventRepository | events, numbering, dedupe keys | SQLite |
| WakeRepository | wakes with reason, through, state and attempts | SQLite |
| SecretStore | secret configuration fields per connector | macOS Keychain, Secret Service, 0600 file |
| ConnectorRuntime | start and stop a connector process; Handshake, Configure, Describe, Watch | child process with stdio RPC; in-memory fake for tests |
| ConnectorDirectory | list installed connectors, read manifests, compute digests, report file changes | file system |
| ConnectorImportSource | place a connector in the connector directory from a source, inert | archive file, https link, local directory, git repository at a ref |
| OfficialConnectorSource | fetch an official connector archive by name and version | release files, local folder |
| WakeTarget | deliver wake text to one session of one harness | T3 Code, Codex, command for the harnesses you define; Claude Code fails each attempt with a fixed reason |
| AlertSink | show a desktop alert | desktop notifications; recording fake for tests |
| ServiceManager | install, start and report the daemon service | Homebrew service, own LaunchAgent, own systemd user unit |
| SettingsStore | read and write the settings file | file in the config directory |

The application uses Effect's clock and scheduling for every timer, so tests drive time with the Effect test clock.

### Records, states and transitions

The daemon stores four records. Fields are as in the domain model:

- Connector: name and version from the manifest; origin (official release, archive file, https link, directory, git repository at a ref, dev link); digest (sha256 of its files); trust (inert, enabled, dev); catalogue (event types, subscription parameters, configuration fields); configuration (one per connector: missing, set, or rejected by the source); process (stopped, running, restarting, failing). A connector is available when it is enabled or dev, its configuration is set and its process runs.
- Subscription: id `sub_…`; connector by name; parameters validated and normalised by the connector; subject and label named by the connector; intent (required, one line); selected event types (all by default); wake target (harness and session id, or none); expires at (at most 7 days after the start or the last resume); max events (optional); state with reason (active, paused, expired, ended, cancelled); cursor; acked through; changes (each create, update, ack, pause, resume, retarget, cancel and event alerts change with actor and time).
- Event: id `evt_…`; number (1, 2, 3 within its subscription); type; occurred at; received at; one-line summary from the connector; payload in the shape its event type declares; optional link; dedupe key. An event is pending while its number is above the subscription's acked through.
- Wake: subscription; reason (events, paused, expired, suspended, ended, cancelled); through (the last event number it covers); state (waiting, sending, delivered, replaced, dropped); attempts (count, last error, time of the next attempt). A subscription has at most one undelivered wake. A wake describes the subscription as it is when sent and never carries the intent.

Only an active subscription is watched. Active, paused and expired are open; ended and cancelled are closed. An active subscription is suspended while its connector is unavailable and continues from its cursor by itself when the connector returns.

| From | When | To | Wake to its session |
|---|---|---|---|
| (new) | A subscribe call succeeds. | active | none |
| active | The backlog reaches 20 events, or its oldest event is 24 hours old. | paused | one, with the ack and resume commands |
| active | An actor pauses it. | paused | one, unless its own session paused it |
| paused, expired | An actor resumes it and the backlog is under the limit. | active | none |
| active | The expiry time passes. | expired | one, with the resume command |
| paused | The expiry time passes. | expired | none, it was told when it paused |
| active | The connector ends it, or it reaches its max events. | ended | one, with the reason |
| any open | An actor cancels it. | cancelled | one, unless its own session cancelled it |
| active | Its connector has been unavailable for 1 hour. | active | one, with the reason |

### Rules

The daemon enforces rules 1 to 21 of the confirmed domain model:

1. A subscribe call needs an available connector and an intent. The connector validates the parameters and names the subject. If the connector is an official one that is not installed yet, that call downloads, checks and enables it. The tray shows the intent on every subscription. The daemon returns it when a session shows or lists subscriptions and never repeats it in a wake.
2. The CLI and the MCP server read the calling session from the environment and store it as the wake target. A T3 Code thread wins when sessions are nested. One flag names another target, and another makes the subscription pull-only. With no session and no flag the call fails and says why.
3. The daemon refuses a subscribe call when an open subscription has the same connector, subject and wake session, and lists what it found with each one's parameters. Resubmitting with those ids creates the second subscription, provided the ids cover every match at that moment. Subscriptions of other sessions do not count.
4. A subscription expires 7 days after it starts or was last resumed. The agent can ask for less with an end time, a number of events, or a single event.
5. An agent can change a subscription's event types, limits, intent and parameters, as long as the connector still reports the same subject.
6. The daemon keeps a reported event when its type is selected and its dedupe key is new for that subscription. It numbers the event and stores it together with the connector's cursor.
7. An event stays pending until an actor acknowledges up to its number or beyond.
8. The first pending event opens a 5 second window. When it closes, the daemon sends one wake that lists every pending event.
9. Each later event causes a new wake that lists every pending event again. Events that stay pending never cause another wake by themselves.
10. The daemon retries an undelivered wake and waits at most 10 minutes between attempts. It stops when the send succeeds, when a newer wake replaces it, or when nothing is left to say.
11. When a subscription stops for a reason other than its own session's action, that session gets one wake with the reason and the commands to continue. This covers the backlog pause, expiry, an end by the connector, and a pause or cancel by another session or by you.
12. `wait` blocks until a subscription has something to say and returns what the wake would contain. It serves pull-only subscriptions and covers a lost wake.
13. A subscription pauses at 20 pending events, or when its oldest pending event is 24 hours old.
14. Resume is an explicit call that sets a fresh expiry. It refuses while the backlog is over the limit and says to acknowledge first. Acknowledging never resumes.
15. A paused or expired subscription is not watched. The daemon stops the connector's watch and keeps the cursor. On resume the connector continues from the cursor and reports what changed meanwhile, where the source can tell.
16. While a connector is unavailable its active subscriptions are suspended, and they continue from their cursors when it returns. A connector is unavailable when it is inert after a file change, disabled or removed by you, crash-looping, or its configuration is missing or rejected. After 1 hour each affected session gets one wake.
17. The connector ends a subscription when its subject is finished or can no longer be watched. The daemon ends it at the requested number of events.
18. Every session can see every subscription, and the default list shows its own. Any session may update, acknowledge, pause, resume, retarget or cancel any subscription. The daemon records who did. This is a convention, not a security boundary.
19. Only you import, enable, disable and remove connectors, in the tray or the CLI. A third-party connector starts inert and returns to inert when its files change. An official connector is enabled once its checksum matches the one the binary carries.
20. Connectors are configured in the tray or through the CLI. The CLI reads each secret from a command, a file, or a hidden prompt for you. An agent names the command or the file, such as `gh auth token` or the file T3's secret input writes, so it sets a secret without seeing it. The MCP server has no tools for connector management or configuration.
21. You get a desktop alert when a connector waits to be enabled, keeps failing or has its credentials rejected, and when an official connector's checksum does not match. A wake target that stays unreachable raises no alert. The tray shows the waiting wake, and the backlog rule catches a session that is gone for good. Event alerts are off unless a setting turns them on, globally or for one subscription. You may switch them for any subscription; a session may switch them only for a subscription it created. Only you change settings, including the global event alerts setting and the default limits, in the tray or the CLI. The daemon refuses a change from an agent session, as with connectors (rule 19). Sessions can still read settings.

### Defaults

All limits are settings. Their defaults:

| Setting | Default |
|---|---|
| Wake window after the first event | 5 s |
| Backlog limit by count | 20 events |
| Backlog limit by age | 24 h |
| Subscription lifetime and maximum age | 7 d |
| Connector unavailable before the session hears | 1 h |
| Longest wait between wake attempts | 10 min |
| Closed subscriptions and their events kept | 30 d |

The standing defaults from the domain model's smaller choices 3 to 10 apply as well. Further notes lists them for the owner.

### Wake text

A wake is plain text. It names the subscription, connector and subject, lists every pending event with number, type and summary, and prints ready-made commands with the full command name `exangelos`, never the alias. Examples from the domain model:

```
2 events on sub_7f3k (github-pr, acme/app#123)
  #4 checks.failed      build and e2e failed
  #5 review.submitted   alice requested changes
Read  exangelos events sub_7f3k
Ack   exangelos ack sub_7f3k --through 5
```

```
sub_7f3k is paused (github-pr, acme/app#123)
Event #5 has been pending for 24 hours. Nothing is watched while paused.
Ack     exangelos ack sub_7f3k --through 5
Resume  exangelos resume sub_7f3k
```

Wakes for expiry, an end, a cancel, a pause by another actor and a suspended connector follow the same shape: one line with the subscription, its state and the reason, then the commands to continue. `wait` returns the same text.

### Daemon use cases

The `application` package implements these use cases. The first group is the daemon service contract, offered to agents and to you:

- List connectors with their catalogues.
- Subscribe (with duplicate check, official connector fetch on first use, wake target from the caller).
- Update (event types, limits, intent, parameters; refused when the subject changes).
- List (own by default, all with a flag) and show (with intent, events, wakes, changes).
- Events (stored events of a subscription, with payloads and links).
- Acknowledge through a number.
- Wait.
- Pause, resume, retarget, cancel.

The second group is offered to the CLI and the tray only, never to the MCP server:

- Import a connector from a source; enable, disable and remove a connector.
- Configure a connector (validates against the catalogue, stores secret fields in the secret store, sends Configure, records who configured it).
- Dev link and unlink.
- Read and change settings.
- Service status (daemon running, version, start method).

The third group runs inside the daemon:

- Ingest: receive events and cursors from a Watch stream, apply rules 6, 13 and 17, and schedule a wake.
- Wake scheduling and delivery: open the window, build the wake, deliver it through the WakeTarget port, retry with backoff capped at 10 minutes, replace older undelivered wakes.
- Limits: pause on backlog, expire on time, end at max events.
- Connector supervision: start enabled and dev connectors, Handshake and refuse incompatible protocol versions, Configure, run one Watch stream per active subscription, restart a crashed process with backoff and resume every stream from its cursor, mark a crash-looping connector as failing and alert you, mark rejected credentials and alert you, suspend and resume subscriptions, send the one wake after 1 hour of unavailability.
- Connector file watch: return a changed third-party connector to inert and alert you that it waits to be enabled; restart a dev connector on change.
- Official connector fetch on first use: download the archive, compare its checksum with the one the binary carries, enable it on a match, keep it inert and alert you on a mismatch, and fail with a clear message when offline.
- Retention: delete closed subscriptions and their events after 30 days, and cancel an expired subscription that nobody resumed for 30 days.

Each change to a subscription or connector records its actor: the session the CLI or MCP server detected, or you. A CLI call with no session in its environment, and every tray call, records you.

### Daemon service contract and transport

- The daemon serves the daemon service contract over a unix socket. File permissions on the socket are the only authentication, since version 1 serves one person on one machine.
- The CLI, the MCP server and the panel are clients of that same contract.
- The contract carries the calling session (harness and session id) on every call, so the daemon can store wake targets and record actors.

### Connector protocol and SDK

- One connector is one installed package in the connector directory, discovered by name. Its manifest declares name, version and the entry, which is either a portable JS bundle or a native executable per platform. The daemon binary runs a JS bundle by acting as the Bun runtime. Its working directory is the connector's folder.
- The manifest is `connector.json` at the top of the connector folder. An optional `files` list names further files or folders the connector needs next to its entry, as paths relative to that folder, for example `"files": ["runtime", "LICENSE"]`. A folder brings every file under it; empty folders are not packed.
- The daemon runs one process per connector. The wire is Effect RPC over the process's stdin and stdout, using one of Effect's own serialisations with framing suitable for pipes (NDJSON; Effect has removed its MessagePack format).
- The connector protocol RPC group has four methods:
  - Handshake. Returns the connector's protocol version and its catalogue.
  - Configure. Receives the configuration with its secrets. Answers accepted, or rejected with a reason.
  - Describe. Receives parameters. Answers the normalised parameters, the subject and a label, or why they are invalid.
  - Watch. A streaming method. Receives parameters, the selected event types, the cursor and the wake window. A changed wake window reopens every Watch stream from its cursor, and a connector that receives no wake window uses 5 s. Streams events (type, occurred at, summary, payload, optional link, dedupe key) and cursors, and may end with a reason.
- The daemon refuses a connector whose protocol version it does not support, and says why.
- Each subscription is one Watch stream. Configuration with secrets reaches the connector at start through Configure.
- A catalogue declares event types with payload schemas, subscription parameters as a schema, and configuration fields (text, choice, secret). The panel and the CLI render the configuration form from it.
- The core has no filter over event payloads. Filtering beyond event types is a connector parameter.
- `connector-sdk` gives authors builders for the catalogue, a function that serves the four handlers over stdio, and an in-memory test harness that drives the handlers without a daemon.
- The `template` connector package has one event type, one parameter, a configuration with a secret field, and tests, and CI builds it. The scaffold command writes a renamed copy of it.

### Connector trust and installation

- Trust is inert, enabled or dev. A third-party connector lands inert. You enable it in the panel or the CLI after seeing its origin and sha256 checksum. Any change to its files returns it to inert.
- Import sources in version 1 sit behind one import port: archive file (zip or tar.gz, with archive entries that would escape the target directory refused), https link to an archive, local directory, git repository at a ref. Every import ends inert in the connector directory. The panel exposes import.
- Official connectors are fetched from release files on first use and enabled by default. The binary carries the checksums of the official connectors built with it. A setting points official connector downloads at a local folder, which is how version 1 runs before anything is published.
- An official connector whose files change no longer matches the checksum the binary carries. It becomes inert and raises the checksum-mismatch alert.
- A connector that declares no configuration fields counts as configured.
- Dev link is CLI-only. It trusts a working directory while linked, restarts the connector when its files change, and labels it dev.
- Exactly one configuration exists per connector. There are no named connections in version 1.

### Official connectors

- `github-pr`. Uses the GitHub API through the Effect HTTP client with a token from the connector configuration (secret). Setup can fill the token from `gh auth token`. It makes conditional requests and has a GitHub Enterprise host setting. The main parameter is the pull request, written `owner/repo#number`. Its catalogue carries over pr-watch's triggers:

  | Event type | Reported when |
  |---|---|
  | `head.changed` | the head commit changes |
  | `base.changed` | the head of the base branch changes |
  | `conflict.detected` | the pull request conflicts with its base |
  | `checks.failed` | a check fails or is cancelled |
  | `checks.passed` | every check is complete and none failed |
  | `review.submitted` | someone submits a review |
  | `review.thread` | a new unresolved review thread appears |
  | `comment.added` | someone adds a comment to the conversation |
  | `merge.ready` | the pull request is open, mergeable and approved or needs no review, with its required checks complete; once per head |

  It ends a subscription when the pull request is merged or closed, with that as the reason. pr-watch's ignore lists become optional parameters: check names, authors and comments to ignore, each as a pattern.
- `jira`. Uses the Jira Cloud REST API with site URL, email and API token (secret), by polling. A subscription targets one issue key or a JQL query. Event types: status changed (`status.changed`), comment added, assignee changed, other field changed, and an issue entering or leaving the JQL result.
- `file-watch`. Watches files on disk. The main parameter is a path glob, such as `~/code/api-gateway/dist/**`, and an optional parameter lists globs to ignore. Event types are `file.created`, `file.changed` and `file.deleted`. Changes to one file inside the wake window become one event. It declares no configuration fields.
- `slack` and `teams` both need the Bun bundle runtime that Exangelos supports, private connector configuration, and writable storage outside the installed connector folder. Neither needs its desktop app or Python to start. Without configuration, each one starts and stays quiet.
- `slack`. It needs Python 3.10 or later as `python3` with SQLite support, and a supported local macOS Slack desktop cache that contains the requested conversation or message. After one-time persisted-cache authorization, Subscribe accepts a positional conversation ID, message permalink or timestamp. A reply selects its thread. A top-level message requires `scope=conversation` or `scope=replies`. The host can see the reference and resolved label. Monitoring is delayed. Its data may be arbitrarily stale, and it may miss intermediate changes.
- `teams`. It needs Python 3.9 or later as `python3` with SQLite and the Unix standard-library facilities it requires, a supported local Teams desktop cache, and a private conversation selection. Monitoring is best effort and was tested with Teams running, so keep Teams running. Live validation covers self-chat on macOS. Other platforms, account variants and channels are unverified.
- `template`. The connector boilerplate described above.

### Wake targets and session detection

- Wake targets are built into the daemon behind the WakeTarget port, with adapters for T3 Code, Claude Code and Codex and a command adapter for the harnesses you define in settings.
- You define a harness in settings with a name and a command, `exangelos settings harness set <name> [--] <program> [args…]`, and remove it with `exangelos settings harness remove <name>`. A name is lowercase letters, digits and dashes, starts with a letter, has at most 32 characters, and is not `t3`, `codex` or `claude-code`. Only you define or remove a harness, as with connectors (rule 19). The daemon refuses the change from an agent session, the MCP server has no tool for it, and `exangelos settings set` and the panel's settings leave the harnesses as they are.
- On a wake the daemon runs the program without a shell and stops it after 30 seconds. In an argument, `{session}` becomes the wake target's session id and `{subscription}` the subscription id. The program takes no placeholder. The wake text goes to the command's standard input, and the environment carries `EXANGELOS_HARNESS`, `EXANGELOS_SESSION_ID` and `EXANGELOS_SUBSCRIPTION`. A session id for a harness you define holds only letters, digits and `. _ : @ -` and does not start with `-`, so it cannot add an argument or pass as an option. A shell you name as the program interprets the values you hand it.
- A subscribe or retarget call that names a harness you have not defined fails and says that you define harnesses. A wake through a harness that fails to start, exits with an error, runs past its 30 seconds or was removed is a failed attempt, and the daemon retries it like any other (rule 10).
- The daemon finds each delivery command at each wake, since a Homebrew service, LaunchAgent or systemd unit runs it with a system PATH that lacks the owner's user directories. A program name without a slash is looked up on the daemon's PATH, then in the usual user install directories (`~/.local/bin`, `~/bin`, Bun, Volta, npm-global, pnpm, the fnm default alias, nvm versions newest first, mise and asdf shims, Cargo), then `/opt/homebrew/bin`, `/usr/local/bin`, Linuxbrew, `/usr/bin` and `/bin`. The command runs by its full path with its own directory first on its PATH, so a Node script finds the node beside it. A program found nowhere fails the attempt with a reason naming it and every directory searched. Nothing about the location is stored with a subscription, so subscriptions made before the lookup recover on their next attempt.
- Known delivery commands, to verify at implementation: T3 Code `t3 thread send <thread> <message>` (a busy thread gets it as its next turn); Codex `codex queue` or `codex exec resume`. Claude Code has none: no local command reaches a running standalone Claude Code session, and `claude --bg --resume` starts a paid copy. Its wake target fails each attempt with a fixed reason and starts no process. The agent runs `exangelos wait <subscription>` in the background instead, and CLI and MCP results for that harness carry a hint line saying so. Claude Code inside T3 Code gets wakes through T3 Code.
- The CLI and the MCP server detect the harness session id from environment variables. A T3 Code thread wins when sessions are nested. The exact Claude Code and Codex environment variables are verified at implementation.
- A subscription has one wake target or none, and any actor can retarget it.

### CLI

The command is `exangelos`. The install also provides the alias `xng`. The binary is one multicall executable for daemon, CLI and MCP server. The owner fixed `subscribe`, `events`, `ack`, `wait`, `resume` and `--intent`. The other command and flag names are defaults listed in Further notes. A connector declares one main parameter, which the CLI takes as a positional value, and the CLI takes every other parameter as a `key=value` pair.

Agent and person commands (daemon service contract):

| Command | Does |
|---|---|
| `exangelos connectors` | list connectors with trust, state and catalogue summary; with a name, show the full catalogue |
| `exangelos subscribe <connector> <params…> --intent "…"` | subscribe; `--types`, `--once`, `--max-events N`, `--until <time>`, `--target <harness>:<session>`, `--pull-only`, and `--similar-ok <ids>` to create a subscription next to the similar ones it was shown |
| `exangelos update <sub>` | change event types, limits, intent or parameters |
| `exangelos list` | own subscriptions; `--all` for every subscription |
| `exangelos show <sub>` | one subscription with intent, events, wakes and changes |
| `exangelos events <sub>` | stored events with payloads and links |
| `exangelos ack <sub> --through N` | acknowledge through event N |
| `exangelos wait <sub>` | block until there is something to say; print the wake text |
| `exangelos pause <sub>`, `resume <sub>`, `cancel <sub>` | change state |
| `exangelos retarget <sub>` | set a new wake target with `--target`, or make it pull-only with `--pull-only` |

Commands for you only (not offered through MCP):

| Command | Does |
|---|---|
| `exangelos connector import <source>` | import from an archive file, https link, directory, or git repository at a ref |
| `exangelos connector enable <name>` | show origin and checksum, then enable |
| `exangelos connector disable <name>`, `connector remove <name>` | disable or remove |
| `exangelos connector configure <name>` | set configuration; each secret from a command, a file, or a hidden prompt |
| `exangelos connector dev-link <dir>`, `connector dev-unlink <name>` | dev loop |
| `exangelos connector scaffold <name>` | write a renamed copy of the template |
| `exangelos settings` | read and change settings; `settings harness set` and `settings harness remove` define and remove harnesses |
| `exangelos service status` | daemon running, version, start method |
| `exangelos logs [-f] [--level <level>] [--since <span or time>] [--connector <name>] [--source daemon\|mcp\|cli] [-n <count>]` | the recent local log records of every process, merged by time; `-f` follows them; works with the daemon down |
| `exangelos debug report [--include-payloads] [--output <path>]` | write a `.tar.gz` of the logs, versions and settings with secrets removed, to attach to an issue |
| `exangelos daemon` | run the daemon in the foreground (used by the service definitions) |
| `exangelos mcp` | run the MCP server over stdio |

The CLI reads a secret source once, at configure time. An agent may run `connector configure` with a command or file source, because the CLI process reads the secret with the agent's permissions and hands the value to the daemon without printing it.

Any CLI or MCP call that finds no daemon starts it (see service management), except `logs` and `debug report`, which read the files and never start it.

### MCP server

- `exangelos mcp` serves MCP over stdio and forwards every call to the daemon over the unix socket. It reads the session identity from its environment for wake addressing.
- MCP tools: list connectors with catalogues, subscribe, update, list, show, events, ack, wait, pause, resume, retarget, cancel, set event alerts. Subscribe requires the intent. Set event alerts works only on a subscription the calling session created.
- Deliberately not MCP tools: connector import, enable, disable, remove, configure, dev link, scaffold, settings (the global event alerts setting and harnesses among them), service status, logs, debug report. An agent that needs to configure a connector uses the CLI with a command or file secret source.

### Tray host and panel

- The tray host is Tauri 2: a Rust host with the panel in the system webview. Rust and the Tauri CLI join the toolchain for the tray app only.
- The tray host relays frames between the webview and the daemon's unix socket and holds no logic. A small Rust relay in the tray app bridges Tauri IPC and the unix socket. The panel holds a client for the same daemon service contract as the CLI and the MCP server, over the Tauri IPC RPC transport gap package.
- The panel UI framework is Foldkit, pinned to an exact version. The RPC client and the host bridge stay outside Foldkit so the view can be replaced.
- The multicall binary ships inside the app as a Tauri sidecar.
- On macOS the panel opens as a dropdown from the menu bar icon. The icon has a quiet state and a "needs you" state.
- On Linux the panel opens as a normal window. The Tauri Linux tray (AppIndicator) delivers no click events, so the tray menu has an item that opens the panel.
- Quitting the tray app leaves the daemon running.

What the panel shows:

- Each subscription: id, connector, subject, label, intent, selected event types, wake target (harness and session, or pull-only), expiry time, state with reason, whether it is suspended, its events with the pending ones marked, its wakes (state, attempt count, last error, time of the next attempt), and its changes (actor and time).
- Each connector: name, version, origin, sha256 digest, trust, configuration state, process state, and who configured it.
- What needs you: a connector waiting to be enabled, a connector that keeps failing, rejected credentials, an official connector whose checksum does not match. Each raises an alert and is findable in the panel.
- An unreachable wake target as a quiet fact on its session and on the waiting wake, not in the "needs you" list.
- Whether the daemon runs, its version and how it started; settings (event alerts on or off globally and per subscription, default limits, and the harnesses you defined, which the panel only lists); quit.
- An empty state that says only agents subscribe and shows `exangelos subscribe github-pr acme/app#123 --intent "Waiting on checks and review"`.

What the panel does:

- On a subscription: acknowledge through a number, pause, resume (refused while the backlog is over the limit), retarget, cancel.
- On connectors: import from any of the four sources, enable after showing origin and checksum, disable, remove, configure through the declared form (text, choice and secret fields; a secret shows only whether it is set).

The panel layout (structure, navigation, grouping) is decided separately. Three structural concepts are under comparison.

### Storage and migrations

- One SQLite file in the data directory, through the Effect SQL client and the Bun SQLite driver, behind the repository ports.
- The daemon applies versioned migrations at start before it serves calls.
- The database file is mutable user data and is never a bundled asset of the binary.

### Secrets

- Secret configuration fields go through the SecretStore port: macOS Keychain, Secret Service on Linux, and a 0600 file on headless machines.
- Secrets never enter the settings file, the database or a wake. They reach the connector at start through Configure.
- Changing a configuration field that says where secrets are sent, such as a host or a site URL, clears the stored secrets.
- When a source rejects credentials, the connector's configuration becomes rejected, its subscriptions are suspended, you get an alert, and the configure command runs again.

### Service management

- Start on first use. Any CLI or MCP call that finds no daemon, other than `logs` and `debug report`, detects the install method and starts the service through it.
- The daemon uses the installer's own service support where it has one. A Homebrew formula install uses the formula's service definition. The bundled desktop install has no service support of its own, so the binary installs its own LaunchAgent (macOS) or systemd user unit (Linux) pointing at itself on first use. The daemon then starts at login and outlives the tray. The install script uses the same own unit.
- Services are user-scoped so the daemon can reach your configuration and keychain.
- The service label is `exangelos.daemon`. It is built from the name alone, so it claims no domain before anything is published.

### Paths

- XDG layout on macOS and Linux: configuration under `~/.config`, data under `~/.local/share`, state under `~/.local/state`, honouring the XDG variables.
- The configuration directory holds the single settings file. The CLI and the tray edit it.
- The data directory holds the database and the connector directory.
- The state directory holds the unix socket, the logs in `logs/` and debug reports in `reports/`.
- The environment variable `EXANGELOS_HOME` collapses every directory into a single one, for tests and side-by-side installs.

### Logging

- Every build, release included, writes structured logs on this machine only. Nothing leaves it: there is no remote telemetry, analytics or crash reporting.
- Each process writes one JSON record per line to its own file in `<state>/logs`: `daemon.jsonl`, `mcp.jsonl` and `cli.jsonl`. A record has the time, level, process, pid, message, and optional annotations (connector, subscription, session, request, method, duration, outcome), spans and cause.
- A file that reaches 5 MiB rotates to `.1.jsonl`; five rotations are kept. Files are mode 0600 in a 0700 directory.
- `daemon.log` in the same directory is the service's own stdout and stderr, for failures before the logger is up.
- Levels are error, warn, info (the default), debug and trace. `exangelos settings set logLevel=debug` changes the level, and the daemon applies it without a restart. Only you change it (rule 21). The environment variable `EXANGELOS_LOG_LEVEL` overrides the setting for the process it is set on.
- Event payloads are logged only at debug.
- Every request from the CLI or an MCP server to the daemon is logged with its method, duration and outcome. A successful request that changes something logs at info; a successful read-only request, which the tray and agents poll, logs at debug so polling does not push history out of the rotated files. A failed request logs at warn, or at error for a defect, with the failure's tag, its fields and the chain of causes, redacted and with every address inside reduced to its scheme, host and path.
- Every record is redacted before it is written: the value of any key whose name contains token, key, secret, password, auth or cookie is replaced, and so is every stored secret value wherever it appears; a stored secret shorter than four characters is replaced where it stands as a whole word. The values of environment variables whose names contain those words are treated as secrets too, since connectors inherit them; a value shorter than four characters is hidden only in connector output and failure text, wherever it appears there. A connector's output and failure text also lose every stored secret wherever it appears, however short, and each line of a secret that spans several. So environment values of sensitive-named variables are redacted everywhere when they have four or more characters, while stored connector secrets are redacted at any length; a shorter environment value is not a usable credential and is hidden only in connector output and failure text. Environment values are never logged, only their names.
- `exangelos logs` reads the files directly, so it works while the daemon is down.
- `exangelos debug report` writes `<state>/reports/exangelos-debug-<UTC time>.tar.gz`. The archive holds the log files and the end of `daemon.log`, redacted again: event payloads are left out unless `--include-payloads` is given, a line of free text that names a credential or carries a URL with credentials, a query or a fragment is replaced whole, and a URL value keeps only its scheme, host and path. It also holds `report.json` with the binary's version and checksum, the connectors' versions, checksums, origins, trust and states (read from the database without changing it when the daemon is down, with the process state marked unavailable), the settings with harness environment values and sensitive keys removed, OS and architecture, install method, the paths in use, and whether `EXANGELOS_LOG_LEVEL` is set. It never overwrites an existing file, starts the daemon or reads the keychain, and it sends nothing. Agent sessions are refused, as for settings.

### Packaging and release scope

- One multicall binary holds daemon, CLI and MCP server, built with `bun build --compile` for the four targets.
- The tray app bundles everything: one desktop download with the binary inside the app, which also puts `exangelos` and `xng` on the PATH.
- Headless installs use the standalone binary through a Homebrew formula or an install script.
- Version 1 delivers build scripts for the four targets, Homebrew formula and cask definitions and an install script, all exercised locally. CI runs the checks on every pull request and on every push to `main`; the release workflow then publishes a GitHub release at the latest `vX.Y.Z` tag plus a patch bump, starting at `v0.1.0`, with the four binaries, the official connector archives, the Linux tray packages and `SHA256SUMS`. The binaries report that version and fetch official connectors from that release. Official connector archives are built as release files with checksums the binary carries. The release build runs the connector's `build` script, then packs `connector.json`, the bundle entry and every file the `files` list names, at the same paths. It refuses a native entry, a listed path that is absolute, leaves the connector folder or does not exist, a listed path that is a link or goes through one, a link or special file under a listed folder, and an archive the connector import would refuse. The checksum is taken over the unpacked archive, so it covers the listed files.
- Each release also pushes the Homebrew formula, rendered with that release's download addresses and checksums, to the tap repository `filip-gooddata/homebrew-exangelos` as `Formula/exangelos.rb`, so `brew tap filip-gooddata/exangelos && brew install exangelos` installs the release binary. The push runs after the GitHub release exists, uses a write deploy key for the tap, and commits only when the formula changed. The cask is rendered but not published: it waits for a signed and notarized macOS app, and there is no Apple Developer account.
- Nothing else is published: no cask, no signing or notarization, no registry or domain reservation, until the owner says so. Dogfooding runs from a local install, with official connectors fetched from a local folder.

### Versions

Pinned exactly:

| Component | Version |
|---|---|
| effect | 4.1.4 (held on 4.1.x while Foldkit's peer range is `~4.1.0`) |
| @effect/platform-bun, @effect/sql-sqlite-bun, @effect/vitest, @effect/platform-browser | 4.1.4 |
| foldkit | 0.170.0 |
| Tauri (Rust crate) | 2.12.5 |
| @tauri-apps/cli, @tauri-apps/api | 2.12.4 |
| Bun | 1.4.2 |
| pnpm | 12.10.1 |
| Rust toolchain for the tray app | stable, cargo 1.99.1 (Tauri 2.12 needs Rust 1.90 or later) |
| Turborepo (turbo) | 2.11.11 |
| Vitest | 5.1.0 |
| Vite | 8.3.8 |
| @effect/tsgo (Effect-aware tsgo, binary `effect-tsgo`) with typescript | 0.68.1 with 7.0.2 |
| @foldkit/vite-plugin | 0.29.0 |
| tauri-nspanel (Rust crate) | 2.1.1 |

The other tools (Turborepo, Vitest, tsgo, the Foldkit Vite plugin, tauri-nspanel) are pinned exactly to their current release when the repository is scaffolded, and the pins are recorded in this table then.

## Testing decisions

The owner's words: "we need to go light on tests. We don't need every nook and cranny tested. Use your judgement to build a healthy test pyramid; not top or bottom heavy."

A good test drives a seam from the outside and checks behaviour an agent or you would notice: what is stored, what wake text goes out, what a call returns or refuses. It does not assert on internal calls or private structure. Time-dependent rules run under the Effect test clock, not real waits.

The pyramid, from the bottom:

- Domain rules (unit). Pure tests on `domain` for the transition table, the backlog limits, expiry, wake content and coalescing, duplicate detection with the acknowledging id list, and acknowledgement. One test per rule and transition, not per edge case.
- Use cases (the widest layer). `application` use cases run against in-memory fakes of every port: a fake ConnectorRuntime that streams scripted events, a recording WakeTarget and AlertSink, in-memory repositories. These cover subscribe through wake, ack, the rule 11 wakes, retry and replacement, suspension and the 1 hour wake, official fetch on first use with matching and mismatching checksums, trust changes on file change, and the MCP-versus-CLI split of the daemon service contract.
- Adapter contracts (integration). The SQLite repositories against a real SQLite file in a temporary collapsed directory, including migrations from empty. The stdio transport and the connector runtime against the real `template` connector as a child process, including a crash and resume from cursor. The archive import adapter, including a path-escaping archive. Each gap package has its own small test suite at this level.
- Connectors. Each official connector is tested through the SDK's in-memory harness with a stubbed HTTP client or a temporary directory: Describe naming the subject, Watch mapping source changes to events with dedupe keys, and the end condition.
- End to end (a few). The compiled binary in a collapsed temporary directory: start on first use, subscribe to the `template` connector, receive a wake through the T3 Code adapter with a stand-in `t3`, define a harness with `exangelos settings harness set` and receive a wake through it with a stand-in command, read, ack, and `wait` on a pull-only subscription. One run of `exangelos mcp` listing its tools and confirming the connector management tools are absent.

Deliberately left untested: the panel's visual layout and the Rust relay beyond a smoke check that the panel loads data; real Keychain and Secret Service access; real launchd, systemd and Homebrew service installation; real delivery into T3 Code, Claude Code and Codex (each is checked by hand once at implementation); Linux desktop variants; the release workflow on all four targets beyond the local run; exact wording of error messages; performance.

Prior art: the repository has no code yet. The tests use `@effect/vitest`, Effect RPC's in-memory test client for the contracts, and the SDK harness. pr-watch's shell test suite shows which behaviours matter for wake delivery and recovery.

## Out of scope

- The Slack and Teams connectors. They wait until version 1 runs on the main workload, then get their own design session.
- A generic `command` source connector.
- Publishing beyond the GitHub release and the Homebrew formula in the tap: no cask, no code signing or notarization, no npm publication of the gap packages, no registry or domain reservation, until the owner says so.
- More than one person or one machine: no remote access, no network listener, no authentication beyond file permissions.
- Named connections or more than one configuration per connector.
- Filtering over event payloads in the core.
- Windows.
- The panel layout, decided separately.
- Final logo vector work. The logo (J7) does not block the spec or the implementation.

## Further notes

### What depends on the open panel layout

Depends on the layout: how the panel groups and orders subscriptions and connectors, how you move between the main view, one subscription, the connector list and settings, and where the "needs you" items and the quiet unreachable-target fact sit. The panel's view code in Foldkit is the only part of the build that waits on it.

Does not depend on the layout: everything else in this spec. That includes the facts the panel shows and the actions it offers, the daemon service contract the panel calls, the Tauri host and Rust relay, the Tauri IPC transport, the menu bar icon's two states, the Linux open-panel menu item, and every daemon, CLI, MCP, connector, storage and packaging decision. The owner can confirm these first.

### Unruled defaults

These are standing defaults that the owner has not ruled on. Each stands unless the owner objects.

1. A paused subscription that reaches its expiry becomes expired without a second wake.
2. The daemon deletes a closed subscription and its events after 30 days. It cancels an expired subscription that nobody resumed for 30 days.
3. The core has no filter over event payloads. Filtering beyond event types is a connector parameter, as the ignore lists of pr-watch are.
4. The CLI reads a secret source once, when the connector is configured. If the source later rejects the credentials, you get an alert and the configure command runs again.
5. Changing a configuration field that says where secrets are sent, such as a host or a site URL, clears the stored secrets.
6. The daemon records who configured a connector, and the tray shows it.
7. Settings live in one file in the config directory. The CLI and the tray edit it.
8. A setting can point official connector downloads at a local folder.
9. The macOS panel uses tauri-nspanel.
10. The Linux panel is always a normal window. The owner asked for a positioned popup where possible, and the Linux tray reports no click position, so there is nothing to position the panel against.
11. Linux tray bundles are built only by the release build workflow, which the release workflow runs and which runs on pull requests that change how the release files are built. Each release carries a `.deb` for x64 and one for arm64, with the release binary inside, installing `exangelos` and `xng` into `/usr/bin`.
12. The tray build calls cargo by absolute path from the existing stable Rust toolchain, with no PATH change and no install.
13. The `cli` app is the entry point of the multicall binary, and `exangelos daemon` and `exangelos mcp` load the other two compositions.
14. Command and flag names are the ones in the CLI tables, with `--target <harness>:<session>`, `--pull-only` and `--similar-ok <ids>`, and parameters as one positional main parameter plus `key=value` pairs.
15. Tools without a pin in the versions table are pinned to their current release when the repository is scaffolded.
16. The github-pr catalogue carries over pr-watch's triggers as event types and its ignore lists as parameters.
17. The file-watch catalogue is a path glob with an optional ignore list, and the event types `file.created`, `file.changed` and `file.deleted`.
18. The unix socket and the logs live in the state directory.
19. The single-directory environment variable is `EXANGELOS_HOME`, and the service label is `exangelos.daemon`.
20. A CLI call with no detected session, and every tray call, records you as the actor.
21. An official connector whose files change becomes inert and raises the checksum-mismatch alert.
22. There is no total age cap across resumes. Every resume is an explicit call that sets a fresh 7 days, as the confirmed domain model says.
23. A connector that declares no configuration fields counts as configured.
24. The connector wire uses NDJSON framing, migrations run when the daemon starts, and the database and the connector directory live in the data directory.

### Open points

None. The points the first draft left open are settled in the text and listed under unruled defaults, items 13 to 24.

The alias `xng` passed its clash check on 2026-11-12. This machine has no command of that name, and PyPI, crates.io, AUR and Debian have no package of that name. npm has an unrelated library called `xng`, which does not affect a command alias. The Homebrew lookup failed, so Homebrew stays unverified.

### Known caveats from the technical reports

- Homebrew's official cask policy and quarantine make an unsigned cask a likely blocker for publication, so only the formula is published. Whether macOS quarantines the unsigned binary that the formula installs has not been checked on a real install.
- Tauri cannot cross-compile between operating systems, so Linux tray bundles need a Linux build host, which is why they are built in the release workflow.
- Electron remains the fallback tray host if Tauri fails on a requirement.
- Effect's RPC, SQL, CLI, process and MCP modules can break in minor releases. The exact pin and the protocol version in the handshake contain that risk.
