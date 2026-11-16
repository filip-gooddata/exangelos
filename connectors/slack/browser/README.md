# Private browser candidate observations

This is a bounded owner-operated evidence tool, not authenticated acquisition or
an SDK connector. No login or live owner actions have occurred in this phase.
Current selectors and scope/message/reaction semantics remain unverified.

## One owner action

Prerequisite: owner available for manual Slack/SSO login, with the existing
isolated Playwright and full Chromium installation accessible at the paths below.
Run this command in an owner-controlled terminal from the checkout root:

```sh
# Set PLAYWRIGHT_MODULE to the absolute Playwright module entry-file path and
# PLAYWRIGHT_BROWSERS_PATH to its browser installation directory.
node connectors/slack/browser/run.mjs owner-login --playwright "$PLAYWRIGHT_MODULE" --browsers "$PLAYWRIGHT_BROWSERS_PATH"
```

In the dedicated Chromium window manually log in, select the intended scope and
open exactly one thread pane. Keep exactly one app.slack.com tab. After
`browser_ready`, enter `p` in the terminal for an observation, wait for its JSON,
then repeat after the owner changes or revisits the selected UI. Login context is
kept for repeated observations in this same process, for up to 30 minutes. Enter
`q` to close. There is no cross-process login persistence or profile import.
Credentials belong only in the browser. No automated typing/clicking, sending,
scrolling or mutation is performed. Share aggregate JSON only, never captures,
URLs, source identifiers/text, profiles, cookies or browser diagnostics.

## Private comparison and output contract

Only fixed booleans and integers 0–200 cross the evaluator and IPC boundaries.
Source values and salted SHA-256 fingerprints never leave the page closure.
Each capture synchronously reads a bounded DOM candidate projection; hashing
happens afterward. Only the previous candidate fingerprint map is retained.
No files store observations. No completeness or stable semantic proof is claimed.

Historical structural candidates inherited from the prior reviewed probe are
`.p-threads_flexpane`, `[data-qa="threads_flexpane"]`,
`.c-message_kit__message`, `[data-qa="message_container"]`,
`.c-message_kit__text`, `[data-qa="message-text"]`, and `.c-timestamp`.
`[data-qa="message_timestamp"]`, row `data-message-id`, ancestor
`data-channel-id`, and reactions `[data-qa="reaction"]` with `data-emoji-name`
and `data-count` are **fixture hypotheses**, not established Slack contracts.
There is no fallback that guesses identity from body, time or URL.

- `probe_ok`, origin, bounds, root/row/field counts retain the structural meaning.
- `candidate_comparison` means two accepted captures share the same root object,
  channel candidate and first-row anchor candidate. It does not verify actual
  account/workspace/thread identity. Re-rendered roots or changed anchors reset.
- `retained_rows` / `added_rows`: matching / newly observed candidate identities.
- `body_changes`: retained rows whose candidate body text fingerprint changed.
- `reaction_additions` / `reaction_missing`: retained rows with any new / missing
  reaction-name-and-count candidate fingerprint. A count change may increment
  both. These are row counts, not reaction or actor counts, and never semantic
  additions/removals. Missing reaction markup is not proven absence.
- `missing_rows`: previously observed candidates absent from the latest capture.
  Virtualization, navigation or rendering can explain absence.
- `comparison_ready`, `complete_snapshot` stay false and `removed_rows` stays zero.
  No deletions or normalized events are emitted without complete scoped proof.

Missing identity/scope/body candidates clear the baseline but can leave structural
`probe_ok` true. Duplicate IDs, malformed reactions, nested rows, forbidden body
subtrees, overflows and exceptions fail closed and reset comparison. Wrong origin,
missing/ambiguous roots and worker errors reset too. Zero matches mean unknown
coverage, not an empty account. A candidate match never proves freshness/delivery.

Discovery/root scans cap at 20,000 elements, rows at 200, row scans at 500 elements,
body scans at 1,000 nodes / 16,384 characters, identity fields at 16,384 characters,
reactions at 50 per row. Body projection refuses inputs, textareas, selects,
scripts, styles and editable subtrees. Other page text, URLs, credentials,
cookies, storage, network bodies and application files are not inspected.

## Isolation and validation

Use `run.mjs` only for owner work. Explicit dependency and browser paths avoid
shared package/lock changes, copying node_modules, and global installations.
The worker has a minimal environment and discarded stdout/stderr. No console,
network-body, screenshot, snapshot, tracing, HAR, video or storage exports exist.
Errors emit fixed booleans only. Browser temporary scaffolding is restrictive and
removed on normal exit; forced termination can leave it. Do not inspect/upload it.
Chromium is not guaranteed RAM-only; OS paging/crash behavior remains outside this
tool's guarantees. Downloads and service workers are disabled; normal Slack/SSO
traffic is necessary. The owner must stop if login requires profile transfer.

Focused fixture command (all browser requests fulfilled locally, full Chromium):

```sh
SLACK_PROBE_PLAYWRIGHT="$PLAYWRIGHT_MODULE" PLAYWRIGHT_BROWSERS_PATH="$PLAYWRIGHT_BROWSERS_PATH" node --test connectors/slack/browser/probe.test.mjs
```

Prior evidence: the supplied `browser-readiness.md` records independent r2 PASS
of manifest SHA-256 `20a423be5cb6558ad9d2071ab16727aed97573f7e34d3735d7e14d71afe90ea7`,
9/9 fixture tests exit 0, blank headed smoke exit 0, and no login/live p/q test.
Those are supplied historical results, not current executions. Its structural
probe/runner/tests are the basis of this extension. The older `RESULT.md` browser
claims are superseded by that readiness record; its separate cache experiment is
not browser evidence and was not rerun. Current results are in `VALIDATION.md`.
