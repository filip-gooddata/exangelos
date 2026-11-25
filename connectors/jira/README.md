# jira

Watches Jira issues and reports what changes on them. The main parameter is `target`: an issue key such as `DEMO-7`, or a JQL query. A subscription to one issue can also watch GitHub for it: pull requests that mention the issue, new commits to some paths, and the release that ships a fix.

## Configuration

- `site`: the Jira Cloud site URL, such as `https://acme.atlassian.net`. Browse links use it.
- `email`: the Atlassian account email.
- `token`: an Atlassian API token. It is a secret. A classic token is sent to the site; a scoped token goes through the `api.atlassian.com` gateway, with the cloud id the site reports. The connector finds the route itself.
- `githubToken`: optional. A GitHub token that can read the repositories you name in `githubRepo`. It is a secret, sent only to `api.github.com`.

To take the Jira credential from a macOS keychain item that holds the account email and the API token (here `jira-api-token`), and the GitHub token from a GitHub CLI login:

```sh
exangelos connector configure jira \
  --secret-command 'site=printf %s https://acme.atlassian.net' \
  --secret-command "email=security find-generic-password -s jira-api-token | awk -F'\"' '/\"acct\"/ {print \$4}'" \
  --secret-command 'token=security find-generic-password -s jira-api-token -w' \
  --secret-command 'githubToken=gh auth token --hostname github.com'
```

macOS asks once whether `security` may read the item. The stored copies do not follow later changes: configure again after Jira or GitHub refuses a token. Leave out the `githubToken` line if you do not watch GitHub.

## Parameters

- `target`: an issue key or a JQL query.
- `kind`: `issue` or `jql`, when the target's shape is not enough.
- `fields`: field ids or names, such as `resolution`, `fixVersions` or `customfield_10010`. `field.changed` then reports only these fields. Default: every field. Status, assignee and comments have their own event types, so `fields` does not affect them.

With an issue target only:

- `githubRepo`: `owner/repo`. Turns on the GitHub signals and reports pull requests that the search matches.
- `githubSearch`: the pull request search text. Default: the issue key.
- `githubPaths`: paths in `githubRepo`. `commit.added` reports each new commit that touches one of them, once, with every watched path it touched.
- `since`: an ISO time. Commits to `githubPaths` are read from it on. Default: the first poll.
- `sha`: a commit SHA. `release.found` reports the newest of the latest five releases that contains it.

List parameters take a JSON array. On the command line, give one value as it is (`githubPaths=src/login.ts`) or several as a JSON array in quotes (`fields='["resolution","fixVersions"]'`).

None of these parameters change the subject, so `exangelos update` can change them on a running subscription. `update` replaces the whole parameter set, so give every parameter you want to keep.

## Events

| Event | Dedupe key |
| --- | --- |
| `status.changed` | `<issue id>:history:<history id>:<item>` |
| `assignee.changed` | `<issue id>:history:<history id>:<item>` |
| `field.changed` | `<issue id>:history:<history id>:<item>` |
| `comment.added` | `<issue id>:comment:<comment id>` |
| `comment.deleted` | `<issue id>:comments-deleted:<last seen comment id>:<count before>:<count after>` |
| `issue.entered` | JQL only |
| `issue.left` | JQL only |
| `pull_request.found` | `<issue id>:github:<repo>#<number>:found` |
| `pull_request.state_changed` | `<issue id>:github:<repo>#<number>:<state>:<updated at>` |
| `commit.added` | `<issue id>:github:<repo>:commit:<sha>` |
| `release.found` | `<issue id>:github:<repo>:release:<sha>` |
| `github.unavailable` | `<issue id>:github:unavailable:<outage number>` |

Jira events come from the issue's changelog and comments, so a change and its reversal between two polls are both reported. The first poll reports no history.

- `pull_request.found` and `pull_request.state_changed` report the pull requests the search matched at the first poll as the baseline, then each new match and each change between `open`, `closed` and `merged`. A search finds at most 100 pull requests.
- `commit.added` reports the commits at the first poll as the baseline, then each new one. It reads the newest 100 commits to each path since `since`; when more than 100 land between two polls, the older ones are missed.
- `release.found` fires once per `sha`, on the first poll too. After it, the connector stops reading releases for that commit.

Changing `githubRepo`, `githubSearch` or `since` starts that part again from a baseline.

A GitHub failure never holds back the Jira events. When GitHub refuses `githubToken`, `githubRepo` or the `sha` commit is gone, or no `githubToken` is configured, the subscription reports `github.unavailable` with the reason, once per outage, and keeps trying GitHub on every poll; after the signals recover, it reports the next outage again. A rate limit or any other GitHub failure skips the GitHub signals for that poll only, without an event. Keep `github.unavailable` in `--types`, or a broken token goes unnoticed.

The watch ends when the issue is gone or the account can no longer see it, and when a JQL query fails or matches more than 1,000 issues.

## Polling

The connector polls once a minute. A poll of an issue reads the issue, its changelog and its comments. With `githubRepo`, it also makes one GitHub search, one commits request per path, and, until `release.found`, one releases request plus a compare for each of the latest five releases, so a tag that moves is seen. GitHub's search API allows 30 requests a minute per token, so about 25 issues with GitHub signals fit in one token.

When Jira rate limits, the connector waits as long as `Retry-After` asks. When GitHub rate limits, that poll skips the GitHub signals and the next poll catches up.

## Cursor

The issue cursor is JSON with `v: 2`. It holds the changelog and comment positions and, with `githubRepo`, the repository, search and `since` it read with, each matched pull request's state, the commits seen per path, and the release found for `sha`. It also records whether the GitHub signals are unavailable and how many outages there were. A `v: 1` cursor carries over: the issue events continue where it stopped, and the GitHub signals start from a baseline. A cursor of an unknown version starts a new baseline, so going back to a 0.1 connector restarts the subscription from the current state and misses what changed in between.

## Moving from watch-jira.sh

| watch-jira.sh | Exangelos |
| --- | --- |
| `CHANGED` on `jira.status` | `status.changed` |
| `CHANGED` on `jira.assignee` | `assignee.changed` |
| `CHANGED` on `jira.resolution`, `jira.fixVersions` | `field.changed` with `fields='["resolution","fixVersions"]'` |
| `CHANGED` on `jira.comments` (the count) | `comment.added`, one per comment, and `comment.deleted` when the count falls |
| `--fields LIST` | `fields` for `field.changed`, and `--types` for status, assignee and comments |
| `--gh-repo OWNER/REPO` | `githubRepo`, with `pull_request.found` and `pull_request.state_changed` |
| `--gh-pr-search QUERY` | `githubSearch` |
| `--gh-path PATH` (repeatable) | `githubPaths`, with `commit.added` |
| `--since ISO` | `since` |
| `--sha SHA` | `sha`, with `release.found`. It also fires when a release already contains the commit at the first poll |
| `AUTH_FAIL` | No count. Jira refusing the token (401, or 403 on the account check) makes the connector unavailable, which suspends the subscription and wakes. GitHub refusing `githubToken` reports `github.unavailable` and Jira events continue |
| `ERROR` | No wake for a failed Jira poll: the daemon logs it and retries with backoff. An issue that is gone ends the subscription with that reason. A GitHub repository or commit that is gone reports `github.unavailable` |
| One-shot exit and re-arm | A subscription keeps watching after each event and dedupes by the keys above. `--max-events 1` ends it after the first event |
| `--site`, `--cloud-id`, `--keychain-item` | `site`, `email` and `token` from `exangelos connector configure`. The gateway route and cloud id are found from the site |
| `--interval SEC` | No equivalent. Polls run once a minute |
| `--name NAME` | The subscription id |
| `--wake-thread ID` | `--target HARNESS:SESSION` |
| `--wake-dry-run`, `--fake-baseline` | No equivalent |
| `once` | No equivalent |
| `status`, `list` | `exangelos list` |
| `stop` | `exangelos cancel SUBSCRIPTION` |
| `wait` | No equivalent. Events wake the target session |

Equivalent subscriptions. Set the shell variables first; the values below are examples. Each subscription wakes the session that runs `exangelos subscribe`, as the script woke `$T3CODE_THREAD_ID` by default. To wake another session, as `--wake-thread ID` did, add `--target HARNESS:SESSION`.

```sh
KEY=DEMO-7 REPO=owner/repo SHA=0123abc
JIRA_TYPES=status.changed,assignee.changed,comment.added,comment.deleted,field.changed

# launch KEY
exangelos subscribe jira "$KEY" fields='["resolution","fixVersions"]' \
  --types "$JIRA_TYPES" \
  --intent "Follow $KEY until it is done"

# launch KEY --gh-repo owner/repo --gh-path src/file.tsx --since 2026-11-23T00:00:00Z
exangelos subscribe jira "$KEY" fields='["resolution","fixVersions"]' \
  githubRepo="$REPO" githubPaths=src/file.tsx since=2026-11-23T00:00:00Z \
  --types "$JIRA_TYPES,pull_request.found,pull_request.state_changed,commit.added,github.unavailable" \
  --intent "Follow $KEY and the code that fixes it"

# launch KEY --gh-repo owner/repo --sha SHA
exangelos subscribe jira "$KEY" fields='["resolution","fixVersions"]' githubRepo="$REPO" sha="$SHA" \
  --types "$JIRA_TYPES,pull_request.found,pull_request.state_changed,release.found,github.unavailable" \
  --intent "Tell $KEY's reporter when a release ships $SHA"
```

## Logo

`icon.svg` is an original mark drawn for Exangelos (MIT): a generic ticket. It is not Atlassian's or Jira's logo.
