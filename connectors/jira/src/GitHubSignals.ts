import { DateTime, Effect, Option } from "effect"
import type { Redacted } from "effect"
import type { GitHubCursor } from "./Cursor.ts"
import { eventTypes } from "./Diff.ts"
import type { JiraEvent } from "./Diff.ts"
import type { GitHub, GitHubError, PullRequest } from "./GitHub.ts"
import type { GitHubSignals } from "./Options.ts"

export interface IssueRef {
  readonly id: string
  readonly key: string
  readonly summary: string
}

export interface GitHubPoll {
  readonly events: ReadonlyArray<JiraEvent>
  readonly cursor: GitHubCursor
}

const timeOr = (value: string | null, fallback: DateTime.Utc): DateTime.Utc =>
  Option.match(value === null || value === "" ? Option.none() : DateTime.make(value), {
    onNone: () => fallback,
    onSome: DateTime.toUtc
  })

const clip = (text: string, length: number): string => text.length <= length ? text : `${text.slice(0, length - 1)}…`

const pullRequestPayload = (issue: IssueRef, repo: string, pr: PullRequest) => ({
  issue,
  repo,
  number: pr.number,
  title: pr.title,
  state: pr.state,
  url: pr.url,
  author: pr.author
})

/**
 * Reads the GitHub signals and diffs them against what the cursor saw. Pull requests and commits
 * have a baseline: the first read, or the first after `githubRepo`, `githubSearch` or `since`
 * changed, reports none of them. A release that contains `sha` is reported on the first read too,
 * once; after that no release is read again for that commit.
 */
export const pollGitHub = (input: {
  readonly github: GitHub["Service"]
  readonly token: Redacted.Redacted<string>
  readonly signals: GitHubSignals
  readonly issue: IssueRef
  readonly previous: GitHubCursor | null
  readonly observedAt: DateTime.Utc
}): Effect.Effect<GitHubPoll, GitHubError> =>
  Effect.gen(function*() {
    const { github, issue, observedAt, signals, token } = input
    const { repo, search } = signals
    const sameRepo = input.previous !== null && input.previous.repo === repo ? input.previous : null
    const since = signals.since ?? sameRepo?.since ?? DateTime.formatIso(observedAt)
    const events: Array<JiraEvent> = []
    const keyPrefix = `${issue.id}:github:${repo}`

    const pullRequests = yield* github.searchPullRequests(token, repo, search)
    const known = sameRepo !== null && sameRepo.search === search
      ? new Map(sameRepo.pullRequests.map((pr) => [pr.number, pr.state]))
      : undefined
    if (known !== undefined) {
      for (const pr of [...pullRequests].sort((a, b) => a.number - b.number)) {
        const before = known.get(pr.number)
        if (before === pr.state) continue
        const occurredAt = timeOr(pr.updatedAt, observedAt)
        events.push(
          before === undefined
            ? {
              type: eventTypes.pullRequestFound,
              occurredAt,
              summary: `${issue.key}: ${repo}#${pr.number} ${pr.state}: ${clip(pr.title, 100)}`,
              payload: pullRequestPayload(issue, repo, pr),
              link: pr.url,
              dedupeKey: `${keyPrefix}#${pr.number}:found`
            }
            : {
              type: eventTypes.pullRequestChanged,
              occurredAt,
              summary: `${issue.key}: ${repo}#${pr.number} ${before} → ${pr.state}: ${clip(pr.title, 100)}`,
              payload: { ...pullRequestPayload(issue, repo, pr), from: before },
              link: pr.url,
              dedupeKey: `${keyPrefix}#${pr.number}:${pr.state}:${pr.updatedAt}`
            }
        )
      }
    }
    const listed = new Set(pullRequests.map((pr) => pr.number))
    const carried = known === undefined
      ? []
      : [...known].filter(([number]) => !listed.has(number)).map(([number, state]) => ({ number, state }))

    const sameSince = sameRepo !== null && sameRepo.since === since ? sameRepo : null
    const paths: Array<GitHubCursor["paths"][number]> = []
    for (const path of signals.paths) {
      const commits = yield* github.commits(token, repo, path, since)
      const seen = sameSince?.paths.find((entry) => entry.path === path)?.seen
      if (seen !== undefined) {
        const old = new Set(seen)
        for (const commit of commits.filter((commit) => !old.has(commit.sha)).reverse()) {
          events.push({
            type: eventTypes.commitAdded,
            occurredAt: timeOr(commit.date, observedAt),
            summary: `${issue.key}: commit ${commit.sha.slice(0, 10)} to ${path} in ${repo}: ${clip(commit.message, 100)}`,
            payload: { issue, repo, path, sha: commit.sha, message: commit.message, url: commit.url, author: commit.author },
            link: commit.url,
            dedupeKey: `${keyPrefix}:${path}:${commit.sha}`
          })
        }
      }
      paths.push({ path, seen: commits.map((commit) => commit.sha) })
    }

    let release: GitHubCursor["release"] = null
    if (signals.sha !== undefined) {
      const sha = signals.sha
      const before = sameRepo?.release?.sha === sha ? sameRepo.release : null
      release = before ?? { sha, checked: [], tag: null }
      if (release.tag === null) {
        const checked = new Set(release.checked)
        const releases = yield* github.releases(token, repo)
        const stillListed: Array<string> = []
        let found: (typeof releases)[number] | undefined
        for (const candidate of releases) {
          if (checked.has(candidate.tag)) {
            stillListed.push(candidate.tag)
            continue
          }
          const contains = yield* github.contains(token, repo, sha, candidate.tag).pipe(
            Effect.map((yes) => yes ? "yes" as const : "no" as const),
            // A draft release can name a tag that does not exist yet: look again on the next poll.
            Effect.catchTag("GitHubNotFound", () => Effect.succeed("unknown" as const))
          )
          if (contains === "yes") {
            found = candidate
            break
          }
          if (contains === "no") stillListed.push(candidate.tag)
        }
        if (found === undefined) {
          release = { sha, checked: stillListed, tag: null }
        } else {
          release = { sha, checked: [], tag: found.tag }
          events.push({
            type: eventTypes.releaseFound,
            occurredAt: timeOr(found.publishedAt, observedAt),
            summary: `${issue.key}: release ${found.tag} of ${repo} contains ${sha.slice(0, 10)}`,
            payload: { issue, repo, sha, tag: found.tag, url: found.url },
            link: found.url,
            dedupeKey: `${keyPrefix}:release:${sha}`
          })
        }
      }
    }

    return {
      events,
      cursor: {
        repo,
        search,
        since,
        pullRequests: [...pullRequests.map(({ number, state }) => ({ number, state })), ...carried],
        paths,
        release
      }
    }
  })
