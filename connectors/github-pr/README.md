# github-pr

Watches one GitHub pull request and reports what changes on it. The main parameter is `owner/repo#number`; a pull request link works too.

## Configuration

- `token`: a GitHub token that can read the repository. It is a secret.
- `host`: a GitHub Enterprise Server host name. Leave it empty for github.com.

## Parameters

- `pullRequest`: `owner/repo#number`.
- `ignoreChecks`, `ignoreAuthors`, `ignoreComments`: regular expressions. A match quiets the notification only. `merge.ready` still waits for an ignored required check, because GitHub does.
- `ignoreIds`: node ids, URLs or URL fragments (`discussion_r123`, `issuecomment-456`) of threads, comments or reviews that never notify. Muting a thread also mutes its replies.
- `wakeOnCheckPass`: regular expressions for checks that report `check.passed`.
- `readyWait`: regular expressions for checks that `merge.ready` also waits for. A matching check must be complete; its outcome does not matter. Default: none.
- `reviewStates`: the review states `review.submitted` reports, from `APPROVED`, `CHANGES_REQUESTED`, `COMMENTED` and `DISMISSED`. Default: all.
- `reviewer`: a login. It turns on reviewer mode (below).
- `baseHead`: a base commit SHA (7 to 40 hex digits), or `current` for the base the first poll sees.
- `reportExistingThreads`: `true` reports the threads that are unresolved at the first poll. Default: `false`.

List parameters take a JSON array. On the command line, where every value is a string, give one value as it is (`readyWait=review`) or several as a JSON array in quotes (`ignoreIds='["IC_1","IC_2"]'`). `reportExistingThreads` takes `true` or `false`.

None of these parameters change the subject, so `exangelos update` can change them on a running subscription. `update` replaces the whole parameter set, so give every parameter you want to keep:

```sh
exangelos update SUBSCRIPTION pullRequest=owner/repo#7 reviewStates='["APPROVED","CHANGES_REQUESTED"]' \
  ignoreIds='["https://github.com/owner/repo/pull/7#discussion_r123"]'
```

## Events

| Event | Dedupe key |
| --- | --- |
| `head.changed` | `head.changed/<head>` |
| `draft.changed` | `draft.changed/<head>/<from>-<to>/<change number>` |
| `base.changed` | `base.changed/<branch>/<base oid>` |
| `conflict.detected` | `conflict.detected/<head>/<base oid>` |
| `checks.failed` | `checks.failed/<head>/<check id>` |
| `checks.passed` | `checks.passed/<head>` |
| `check.passed` | `check.passed/<head>/<check name>` |
| `review.submitted` | `review.submitted/<review id>` |
| `review.thread` | `review.thread/<thread id>` |
| `review.reply` | `review.reply/<comment id>` |
| `comment.added` | `comment.added/<comment id>` |
| `merge.ready` | `merge.ready/<head>` |
| `reviewer.submitted` | `reviewer.submitted/<review id>` |
| `review.rerequested` | `review.rerequested/<request event id>` |
| `author.activity` | `author.activity/<comment id>` |

The watch ends when the pull request is merged or closed, and gives that as the reason.

The first poll reports the current state: a conflict, failed checks, passed checks and readiness. It reports none of the history before it: no earlier reviews, comments, threads, replies or draft changes.

- `draft.changed` reports every change after the first poll, ready to draft included, with `from` and `to` set to `draft` or `ready`.
- `base.changed` without `baseHead` reports every move of the base branch. For a pull request into a busy trunk that is noise: leave `base.changed` out of `--types`. With `baseHead`, it reports a base that differs from the pinned one, once per base commit, and on the first poll too. With `current`, the pin is the base the first poll saw, kept in the cursor. Changing `baseHead` through `update` pins again.
- `conflict.detected` fires when `mergeable` is `CONFLICTING` or `mergeStateStatus` is `DIRTY`.
- `check.passed` fires once per matching check per head when it passes, on the first poll too. Ignored checks never fire it.
- `review.reply` fires for each new comment after the first in any thread, resolved or not. Review comments count from when their review was submitted.

### Reviewer mode

`reviewer=LOGIN` turns on three events that need to know who the reviewer is:

- `reviewer.submitted`: LOGIN submitted a review in any state, `COMMENTED` included. The payload has `state`, `reviewId`, `submittedAt` and `commit`.
- `review.rerequested`: LOGIN was asked to review again after a review of theirs. It reads review-request events from the timeline, so a request made and answered between two polls is not lost. A request LOGIN has already answered with a later review is not reported. On the first poll it fires when LOGIN is a requested reviewer and has reviewed before.
- `author.activity`: the pull request's author commented, opened a review thread or replied in one, resolved threads included.

Without `reviewer` these events never fire. The parameter only adds them; it does not mute anything. Choose what reviewer mode hears with `--types`, usually `head.changed,reviewer.submitted,review.rerequested,author.activity`. The merged or closed end applies in every mode.

## Polling

The connector polls once a minute. A poll is one GraphQL query to `https://api.github.com/graphql`, or `https://HOST/api/graphql` on Enterprise, and costs about 3 points of the 5,000 a token gets per hour. Fifty watched pull requests use about 9,000 points an hour, which is more than one token's budget. Watch fewer, or give the connector its own token.

The GraphQL endpoint sends no ETag, so it has no conditional requests.

A reply can arrive on any thread, so every poll reads every page of review threads, 100 threads a page. When a review, comment, review request or thread reply list has more than one page of new activity, the connector asks for older pages until it reaches what the last poll saw. Before each page it reads the quota headers. When `x-ratelimit-remaining` is 0, it waits until `x-ratelimit-reset`. On a secondary limit (HTTP 429, or 403 naming a rate limit) it waits as long as `retry-after` asks, then asks for the same page again. When a whole poll is refused, it waits at least as long as GitHub asks, backing off from one minute and doubling up to 15 minutes.

## Cursor

The cursor is JSON with `v: 2`. It holds the head, the base branch and oid, which failures, passes, passed checks, conflict and readiness were already reported for that head, the draft state and how often it changed, the pinned base, the reviewer's latest review time, and for reviews, comments, threads, replies and review requests the newest time seen plus the ids seen at that instant.

A `v: 1` cursor carries over. Replies and review requests start from the newest review, comment or thread it recorded, so replies made since its last poll are reported. The draft state, pinned base and reviewer start from the next poll, which reports no change. A cursor of an unknown version starts a new baseline.

## Long-lived watches

A subscription expires after the daemon's lifetime, 7 days by default, and keeps a backlog of at most 20 events. A pull request can stay open longer. When it expires, the wake says so and ends with a ready-made command:

```text
Resume  exangelos resume SUBSCRIPTION
```

`exangelos resume` restarts the watch with a fresh expiry from the stored cursor, so nothing GitHub still lists is lost.

## Moving from pr-watch

| pr-watch | Exangelos |
| --- | --- |
| `MERGED`, `CLOSED` | The subscription ends with that reason |
| `HEAD_CHANGED` | `head.changed` |
| `BASE_CHANGED` | `base.changed` with `baseHead` |
| `DRAFT_CHANGED` | `draft.changed` |
| `CONFLICTING` | `conflict.detected` |
| `FAILING_CHECKS` | `checks.failed` |
| `THREADS` | `review.thread`, with `reportExistingThreads=true` for threads open at launch; `review.reply` for replies |
| `REVIEW` | `review.submitted`; `reviewStates` for pr-watch's default of approvals and change requests only |
| `COMMENT` | `comment.added` |
| `CHECK_PASSED` | `check.passed` with `wakeOnCheckPass` |
| `READY` | `merge.ready`, with `readyWait` |
| `REVIEW_SUBMITTED` | `reviewer.submitted` |
| `REREQUESTED` | `review.rerequested` |
| `AUTHOR_ACTIVITY` | `author.activity` |
| `GHFAIL` | No wake for a failed poll: the daemon logs it and retries with backoff. A refused token makes the connector unavailable, which suspends the subscription and wakes |
| `QUIET` | Nothing is sent |
| `--base-head SHA` or `current` | `baseHead=SHA` or `baseHead=current`, with `base.changed` in `--types` |
| `--updates-only` | `--types head.changed,draft.changed,review.submitted,comment.added` |
| `--reviewer LOGIN` | `reviewer=LOGIN` and reviewer-mode `--types` |
| `--reviewer none` | `exangelos update` without `reviewer`, and owner-mode `--types` |
| `--ignore URL`, `ignore add` | `ignoreIds`, changed with `exangelos update` |
| `--ignore-check`, `--ignore-author`, `--ignore-comment` | `ignoreChecks`, `ignoreAuthors`, `ignoreComments` |
| `--ready-wait RE` (default `review`) | `readyWait` (default none, case-sensitive: write `[Rr]eview`) |
| `--wake-on-check-pass RE` | `wakeOnCheckPass` and `check.passed` in `--types` |
| `--bot RE` | No equivalent. The author is in every payload; `ignoreAuthors` mutes |
| `--wake-thread ID` | `--target HARNESS:SESSION` |
| `--wake-cmd` | No equivalent |
| `--interval`, `--max-fail` | No equivalent. Polls run once a minute |
| `stop` | `exangelos cancel SUBSCRIPTION` |
| `status` | `exangelos list` |

pr-watch exits on its first trigger and needs a relaunch. A subscription keeps watching after each event and dedupes by the keys above.

Equivalent subscriptions:

```sh
# launch owner/repo N
exangelos subscribe github-pr owner/repo#N \
  reviewStates='["APPROVED","CHANGES_REQUESTED"]' readyWait='[Rr]eview' reportExistingThreads=true \
  --types head.changed,draft.changed,conflict.detected,checks.failed,review.thread,review.reply,review.submitted,comment.added,merge.ready \
  --intent "Drive owner/repo#N to merge"

# launch owner/repo N --base-head current (a stack layer)
exangelos subscribe github-pr owner/repo#N baseHead=current \
  reviewStates='["APPROVED","CHANGES_REQUESTED"]' readyWait='[Rr]eview' reportExistingThreads=true \
  --types head.changed,base.changed,draft.changed,conflict.detected,checks.failed,review.thread,review.reply,review.submitted,comment.added,merge.ready \
  --intent "Restack owner/repo#N when the layer below moves"

# launch owner/repo N --updates-only
exangelos subscribe github-pr owner/repo#N \
  --types head.changed,draft.changed,review.submitted,comment.added \
  --intent "Wait for an update on owner/repo#N"

# launch owner/repo N --reviewer LOGIN
exangelos subscribe github-pr owner/repo#N reviewer=LOGIN \
  --types head.changed,reviewer.submitted,review.rerequested,author.activity \
  --intent "Review owner/repo#N when its author asks"
```

## Logo

`icon.svg` is an original mark drawn for Exangelos (MIT). It is not GitHub's logo.
