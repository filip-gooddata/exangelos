# github-repo

Watches one GitHub repository for release activity: tags and branches that appear, move or go away, published releases, and finished workflow runs. The main parameter is `owner/repo`; a repository link works too.

## Configuration

The same as [github-pr](../github-pr/README.md#configuration), configured on its own:

- `token`: a GitHub token that can read the repository, and its Actions when you watch workflows. It is a secret.
- `host`: a GitHub Enterprise Server host name. Leave it empty for github.com.

```sh
exangelos connector configure github-repo \
  host=github.com \
  --secret-command 'token=gh auth token --hostname github.com'
```

## Parameters

Give at least one of `tags`, `branches`, `releases` and `workflows`.

- `repository`: `owner/repo`.
- `tags`: tag name patterns.
- `branches`: branch name patterns.
- `releases`: tag name patterns of the releases to report; `*` for every release.
- `workflows`: workflow file names, such as `release.yaml`, or workflow ids.

A pattern is a glob: `*` matches any run of characters, `/` included, and `?` matches one character. Every other character matches itself, so `release/mic/4.45` matches only that branch and `release/mic/*` matches every branch under `release/mic/`.

List parameters take a JSON array. On the command line give one value as it is (`tags='v4.45*'`) or several as a JSON array in quotes (`branches='["main","release/*"]'`).

None of these parameters change the subject, so `exangelos update` can change them on a running subscription. `update` replaces the whole parameter set, so give every parameter you want to keep. A part whose patterns changed takes a new silent baseline on its next poll.

## Examples

Wake before a release publishes: the release branch moves, or the publish workflow creates the release tag.

```sh
exangelos subscribe github-repo gooddata/gdc-mastercard-panther tags='mic-lib-v4.45*' branches='release/mic/4.45' \
  --types tag.created,tag.moved,branch.created,branch.moved,branch.deleted \
  --intent "Act on mic-lib 4.45 before it publishes"
```

Also hear when the publish workflow finishes, and how:

```sh
exangelos subscribe github-repo gooddata/gdc-mastercard-panther tags='mic-lib-v4.45*' workflows=mic-release-publish.yaml \
  --types tag.created,tag.moved,workflow.completed \
  --intent "Check the mic-lib 4.45 publish"
```

Every published release:

```sh
exangelos subscribe github-repo owner/repo releases='*' --types release.published --intent "Read each release's notes"
```

## Events

| Event | When | Dedupe key |
| --- | --- | --- |
| `tag.created` | A tag matching `tags` appears | `tag.created/<name>/<sha>` |
| `tag.moved` | A tag matching `tags` points at another commit | `tag.moved/<name>/<previous sha>/<sha>` |
| `branch.created` | A branch matching `branches` appears | `branch.created/<name>/<sha>` |
| `branch.moved` | The head of a matching branch changes | `branch.moved/<name>/<previous sha>/<sha>` |
| `branch.deleted` | A matching branch is deleted | `branch.deleted/<name>/<previous sha>` |
| `release.published` | A release whose tag matches `releases` is published | `release.published/<release id>` |
| `workflow.completed` | A run of a workflow in `workflows` completes; the payload has its `conclusion` | `workflow.completed/<run id>/<attempt>` |

The first poll is a silent baseline: tags, branches, releases and runs that exist then are not reported. An annotated tag is reported at the commit it points to, so recreating it on the same commit is not a move. Tag deletions are not reported. A draft release is reported when it is published, while it is among the 20 newest releases. A re-run of a workflow run is a new attempt and is reported again.

## Polling

The connector polls once a minute.

- Tags, branches and releases come from one GraphQL query to `https://api.github.com/graphql`, or `https://HOST/api/graphql` on Enterprise. It asks for refs under `refs/tags/` and `refs/heads/` narrowed by each pattern's literal start (the text before its first `*` or `?`), 100 a page, and for the 20 newest releases. It costs 1 point of the 5,000 a token gets per hour, about 60 points an hour. A pattern that starts with a wildcard lists every tag or branch. A listing longer than 100 refs costs one more query per page, and the watch fails with a request for a narrower pattern past 1,000.
- Each workflow costs one REST request to `GET /repos/{owner}/{repo}/actions/workflows/{workflow}/runs?status=completed&per_page=20`, sent with the ETag of the last answer. An unchanged list answers 304, which GitHub does not count against the rate limit.
- A subscription with no tags, branches or releases sends no GraphQL query.

Rate limits are handled as in github-pr: when `x-ratelimit-remaining` is 0 the next poll waits until `x-ratelimit-reset`, a refused poll waits as long as GitHub asks and backs off up to 15 minutes, and an unreachable GitHub is retried three times before the watch fails.

## Cursor

The cursor is JSON with `v: 1`. It holds, for tags and for branches, the patterns and each matching ref's commit; for releases the patterns, the ids of the newest releases and the oldest of their publish times; and per workflow the run id and attempt of the newest completed runs and the oldest of their update times. A release or run older than that oldest time is one a deletion pushed into the list, and is not reported. A cursor of an unknown version starts a new baseline.

## Long-lived watches

A subscription expires after the daemon's lifetime, 7 days by default. `exangelos resume SUBSCRIPTION` restarts it from the stored cursor, so a tag created in between is still reported when it still exists.
