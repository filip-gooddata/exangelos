---
name: exangelos
description: Watch a GitHub pull request, a stack layer, a PR you review, a Jira issue or a Slack or Teams conversation with an Exangelos subscription that wakes this agent session on each event. Use whenever work waits on someone else's change, on CI, or on a reply, and when an Exangelos wake arrives.
---

# Exangelos watches

The `exangelos` daemon keeps one subscription per watched subject, polls it, stores numbered events and wakes the target session with a message. A subscription keeps watching after each event: acknowledge what you handled instead of subscribing again. `exangelos <command> --help` and `exangelos connectors <name>` (parameters and event types) are the reference.

## Subscribe

Always pass `--intent`: one line, for the human, on why the watch exists. `--target <harness>:<session id>` (`t3`, `claude-code`, `codex`) picks the session to wake; it defaults to the calling session. Quote subjects and values that contain `#`, `[` or spaces. List parameters take a JSON array.

```bash
# A PR you own, driven to merge
exangelos subscribe github-pr 'owner/repo#N' \
  reviewStates='["APPROVED","CHANGES_REQUESTED"]' readyWait='["[Rr]eview"]' reportExistingThreads=true \
  --types head.changed,draft.changed,conflict.detected,checks.failed,review.thread,review.reply,review.submitted,comment.added,merge.ready \
  --intent "Drive owner/repo#N to merge"

# A stack layer: also wake when the layer below moves
exangelos subscribe github-pr 'owner/repo#N' baseHead=current \
  reviewStates='["APPROVED","CHANGES_REQUESTED"]' readyWait='["[Rr]eview"]' reportExistingThreads=true \
  --types head.changed,base.changed,draft.changed,conflict.detected,checks.failed,review.thread,review.reply,review.submitted,comment.added,merge.ready \
  --intent "Restack owner/repo#N when the layer below moves"

# Only updates, while a known blocker remains
exangelos subscribe github-pr 'owner/repo#N' \
  --types head.changed,draft.changed,review.submitted,review.reply,comment.added \
  --intent "Wait for an update on owner/repo#N"

# A PR you review
exangelos subscribe github-pr 'owner/repo#N' reviewer=LOGIN \
  --types head.changed,reviewer.submitted,review.rerequested,author.activity \
  --intent "Review owner/repo#N when its author asks"

# A Jira issue
exangelos subscribe jira KEY fields='["resolution","fixVersions"]' \
  --types status.changed,assignee.changed,comment.added,comment.deleted,field.changed,jira.unavailable \
  --intent "Follow KEY until it is done"

# A Jira issue with GitHub signals: commits to paths, or a release containing a fix
exangelos subscribe jira KEY githubRepo=owner/repo githubPaths='["src/billing"]' since=2026-11-01T00:00:00Z \
  --types status.changed,comment.added,commit.added,pull_request.found,pull_request.state_changed,github.unavailable \
  --intent "Follow KEY and the commits that fix it"
exangelos subscribe jira KEY githubRepo=owner/repo sha=SHA \
  --types status.changed,release.found,github.unavailable \
  --intent "Tell me when the fix for KEY ships"
```

- Slack and Teams: `exangelos connectors slack` and `exangelos connectors teams` list their subjects and parameters.
- On a PR into a busy trunk, leave `base.changed` out, or every push to the trunk wakes you.
- `wakeOnCheckPass='["RE"]'` with `check.passed` wakes when a matching check succeeds. `ignoreChecks`, `ignoreAuthors`, `ignoreComments` (regexes) and `ignoreIds` (thread, comment or review URLs) quiet notifications.
- `--once` or `--max-events N` ends the subscription after that many events. `--until <ISO time>` ends it earlier than the default expiry.
- `subscribe` refuses a near-duplicate of an open subscription and names it. Reuse that one, or pass `--similar-ok <ids>` when a second one is intended.
- Configure a connector once, before its first subscription, for example:
  ```bash
  exangelos connector configure github-pr --secret-command 'token=gh auth token --hostname github.com'
  exangelos connector configure jira site=https://acme.atlassian.net email=you@example.com --secret-command 'token=<command printing the API token>'
  ```

Record the subscription id wherever you record the work (report, state file, brief result).

## Wake

A wake lists the new events with their numbers and ends with the commands to read and acknowledge them. To block on one subscription instead of waiting for the message, run `exangelos wait <sub>`; it prints the wake text.

1. `exangelos events <sub>` prints payloads and links. Quote head, base and event time with every claim.
2. Handle the events.
3. `exangelos ack <sub> --through N`. Acknowledge the `head.changed` from your own pushes too.
4. To accept a trigger as it is, mute it: `exangelos update <sub> key=value …` with `ignoreIds` or `ignoreChecks`. Parameters given to `update` replace the whole parameter set, so repeat every parameter you keep.
5. `merge.ready` fires once per head. Report it and keep the subscription.

A push needs no new subscription: the subscription follows the new head.

## End, pause and renew

- Merged or closed PR, or a Jira issue that is gone: the connector ends the subscription and the wake gives the reason.
- Work done, or the human says stop: `exangelos cancel <sub>`.
- Backlog: at 20 unacknowledged events, or the oldest 24 hours old, the subscription pauses. Ack, then `exangelos resume <sub>`.
- Expiry: a subscription lasts 7 days. The expiry wake ends with `exangelos resume <sub>`: ack the backlog, then resume if the watch is still needed, or subscribe again with current parameters.
- A refused credential suspends the subscription and wakes you. Tell the human; reconfiguring the connector is their step.

## Inspect

`exangelos list` (this session's subscriptions; `--all` for every one), `exangelos show <sub>` (intent, events, wakes, changes), `exangelos logs`, `exangelos connectors`. Add `--json` for machine output. A periodic check runs `exangelos list --json` and acts only on paused, suspended or expired subscriptions.

## Moving from watch-pr.sh and watch-jira.sh

Each connector README maps every old option to its replacement: [github-pr](https://github.com/filip-gooddata/exangelos/blob/main/connectors/github-pr/README.md#moving-from-pr-watch) and [jira](https://github.com/filip-gooddata/exangelos/blob/main/connectors/jira/README.md#moving-from-watch-jirash). A legacy watch keeps running until it fires; then replace it with a subscription instead of relaunching it.
