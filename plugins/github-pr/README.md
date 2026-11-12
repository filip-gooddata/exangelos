# github-pr

Watches one GitHub pull request and reports what changes on it. The main parameter is `owner/repo#number`; a pull request link works too.

## Configuration

- `token`: a GitHub token that can read the repository. It is a secret.
- `host`: a GitHub Enterprise Server host name. Leave it empty for github.com.

## Parameters

- `pullRequest`: `owner/repo#number`.
- `ignoreChecks`, `ignoreAuthors`, `ignoreComments`: regular expressions. A match quiets the notification only. `merge.ready` still waits for an ignored required check, because GitHub does.

## Polling

The plugin polls once a minute. Each poll is one GraphQL query to `https://api.github.com/graphql`, or `https://HOST/api/graphql` on Enterprise, and costs 1 point of the 5,000 a token gets per hour. Fifty watched pull requests use 3,000 points an hour, which leaves room for the person's own use of the same token.

The GraphQL endpoint sends no ETag, so it has no conditional requests.

When a review, comment or thread list has more than one page of new activity, the plugin asks for older pages until it reaches what the last poll saw. Before each page it reads the quota headers. When `x-ratelimit-remaining` is 0, it waits until `x-ratelimit-reset`. On a secondary limit (HTTP 429, or 403 naming a rate limit) it waits as long as `retry-after` asks, then asks for the same page again. When a whole poll is refused, it waits at least as long as GitHub asks, backing off from one minute and doubling up to 15 minutes.

## Events

| Event | Dedupe key |
| --- | --- |
| `head.changed` | `head.changed/<head>` |
| `base.changed` | `base.changed/<branch>/<base oid>` |
| `conflict.detected` | `conflict.detected/<head>/<base oid>` |
| `checks.failed` | `checks.failed/<head>/<check id>` |
| `checks.passed` | `checks.passed/<head>` |
| `review.submitted` | `review.submitted/<review id>` |
| `review.thread` | `review.thread/<thread id>` |
| `comment.added` | `comment.added/<comment id>` |
| `merge.ready` | `merge.ready/<head>` |

The watch ends when the pull request is merged or closed, and gives that as the reason.

## Cursor

The cursor is JSON with `v: 1`. It holds the head, the base branch and oid, which failures, passes, conflict and readiness were already reported for that head, and for reviews, comments and threads the newest creation time seen plus the ids created at that instant. A cursor of an unknown version starts a new baseline: the first poll reports the current state but none of the history before it.
