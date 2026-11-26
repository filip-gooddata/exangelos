# github-repo

Watches one GitHub repository for release activity: tags and branches that appear, move or go away, published releases, and workflow runs that start or finish. The main parameter is `owner/repo`; a repository link works too.

## Configuration

The same as [github-pr](../github-pr/README.md#configuration), configured on its own:

- `token`: a GitHub token that can read the repository, and its Actions when you watch workflows. It is a secret. A token GitHub refuses (401) is rejected for every subscription; a token that may not read one repository's Actions (403) fails only that subscription.
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

The repository is the subject and cannot change. `tags`, `branches`, `releases` and `workflows` do not change the subject, so `exangelos update` can change them on a running subscription; it replaces the whole parameter set, so give every parameter you want to keep. A part whose patterns changed takes a new silent baseline on its next poll, and a newly added workflow starts from a baseline too.

## Examples

Wake before a release publishes. A publish workflow that pushes the release tag and publishes in the next step leaves no time to act on the tag, so watch the workflow too: `workflow.started` arrives within a poll of the run being queued, while it still installs and builds. The release branch moving and the tag appearing come as well.

```sh
exangelos subscribe github-repo gooddata/gdc-mastercard-panther tags='mic-lib-v4.45*' branches='release/mic/4.45' \
  workflows=mic-release-publish.yaml \
  --types workflow.started,tag.created,tag.moved,branch.created,branch.moved,branch.deleted,workflow.completed \
  --intent "Act on mic-lib 4.45 before it publishes"
```

How much lead time `workflow.started` gives depends on how long the run takes to reach the step that publishes, less up to a minute of polling. A run that publishes within a minute of starting can publish first. To stop a release reliably, make the workflow wait for an approval, for example with a GitHub environment that has required reviewers.

Every published release:

```sh
exangelos subscribe github-repo owner/repo releases='*' --types release.published --intent "Read each release's notes"
```

## Events

| Event | When | Dedupe key |
| --- | --- | --- |
| `tag.created` | A tag matching `tags` appears | `tag.created/<name>/<sha>` |
| `tag.moved` | A tag matching `tags` points at another commit | `tag.moved/<name>/<sha>` |
| `branch.created` | A branch matching `branches` appears | `branch.created/<name>/<sha>` |
| `branch.moved` | The head of a matching branch changes | `branch.moved/<name>/<sha>` |
| `branch.deleted` | A matching branch is deleted | `branch.deleted/<name>/<previous sha>` |
| `release.published` | A release whose tag matches `releases` is published | `release.published/<release id>` |
| `workflow.started` | A run of a workflow in `workflows`, or a new attempt of one, is queued or running | `workflow.started/<run id>/<attempt>` |
| `workflow.completed` | A run of a workflow in `workflows` completes; the payload has its `conclusion` | `workflow.completed/<run id>/<attempt>` |

The first poll is a silent baseline: tags, branches, releases and runs that exist then are not reported. A move is keyed by the ref and the commit it moved to, so a ref that returns to a commit it was already reported at, such as a branch going A to B to C and back to B, does not wake again. An annotated tag is reported at the commit it points to, so recreating it on the same commit is not a move. Tag deletions are not reported. A release is reported when it is published after the last poll, by GitHub's clock, a draft created long before included, while it is among the 20 newest releases by creation; a release published earlier that a deletion brings into the list is not. A run that starts and finishes between two polls is reported only as completed. A re-run is a new attempt and is reported again, while the run is among the 20 newest. A run is new when GitHub numbered it after the newest run the last poll saw, so an older one that a deletion brings into the list is not reported.

## Polling

The connector polls once a minute.

- Tags, branches and releases come from one GraphQL query to `https://api.github.com/graphql`, or `https://HOST/api/graphql` on Enterprise. It asks for refs under `refs/tags/` and `refs/heads/` narrowed by each pattern's literal start (the text before its first `*` or `?`), 100 a page, and for the 20 newest releases. A query like this typically costs 1 point of the GraphQL budget, about 60 points an hour per subscription. With a personal token the budget, 5,000 points an hour on github.com, is per user and shared by everything that uses that user's tokens. A pattern that starts with a wildcard lists every tag or branch. A listing longer than 100 refs costs one more query per page, and the watch fails with a request for a narrower pattern past 1,000.
- Each workflow costs one REST request to `GET /repos/{owner}/{repo}/actions/workflows/{workflow}/runs?per_page=20`, sent with the ETag of the last answer. An unchanged list answers 304, which GitHub does not count against the rate limit. While a run is in progress the list changes and each request counts against the REST budget.
- A subscription with no tags, branches or releases sends no GraphQL query.

Rate limits are handled as in github-pr: when `x-ratelimit-remaining` is 0 the next poll waits until `x-ratelimit-reset`, a refused poll waits as long as GitHub asks and backs off up to 15 minutes, and an unreachable GitHub is retried three times before the watch fails.

## Cursor

The cursor is JSON with `v: 1`. It holds, for tags and for branches, the patterns and each matching ref's name and commit as pairs; for releases the patterns, GitHub's time of the last poll (from its `date` header) and the ids of the published releases it listed; and per workflow the highest run id seen and the id, attempt and completion of each run the last poll listed. A cursor of an unknown version starts a new baseline.

## Long-lived watches

A subscription expires after the daemon's lifetime, 7 days by default. `exangelos resume SUBSCRIPTION` restarts it from the stored cursor, so a tag created in between is still reported when it still exists.
