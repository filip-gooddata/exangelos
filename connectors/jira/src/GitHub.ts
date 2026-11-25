import { Context, Effect, Layer, Option, Redacted, Schema } from "effect"
import { Headers, HttpClient, HttpClientRequest } from "effect/http"
import type { HttpClientResponse } from "effect/http"

/**
 * The GitHub REST calls behind a subscription's GitHub signals: pull requests that mention the
 * issue, new commits to watched paths, and releases that contain a commit. Requests go to
 * api.github.com with the configured `githubToken`.
 */

const api = "https://api.github.com"

/** GitHub answered 401, or 403 without a rate limit: the token is wrong, revoked or not authorised for the organisation. */
export class GitHubRejected extends Schema.TaggedError<GitHubRejected>()("GitHubRejected", {
  status: Schema.Finite
}) {}

/** GitHub answered 404: the repository or commit does not exist or the token cannot see it. */
export class GitHubNotFound extends Schema.TaggedError<GitHubNotFound>()("GitHubNotFound", {
  path: Schema.String
}) {}

/** GitHub answered 429, or 403 naming a rate limit. */
export class GitHubRateLimited extends Schema.TaggedError<GitHubRateLimited>()("GitHubRateLimited", {}) {}

/** Any other status, no answer, or a body of the wrong shape. */
export class GitHubFailure extends Schema.TaggedError<GitHubFailure>()("GitHubFailure", {
  reason: Schema.String
}) {}

export type GitHubError = GitHubRejected | GitHubNotFound | GitHubRateLimited | GitHubFailure

export type PullRequestState = "open" | "closed" | "merged"

export interface PullRequest {
  readonly number: number
  readonly title: string
  readonly state: PullRequestState
  readonly url: string
  readonly author: string | null
  readonly updatedAt: string
}

export interface Commit {
  readonly sha: string
  readonly message: string
  readonly url: string
  readonly author: string | null
  readonly date: string
}

export interface Release {
  readonly tag: string
  readonly url: string
  readonly publishedAt: string | null
}

/** How many of the newest releases a poll looks at, as watch-jira.sh does. */
export const releasesChecked = 5

export class GitHub extends Context.Service<GitHub, {
  /** Proves that the token can read the repository. */
  readonly checkRepository: (token: Redacted.Redacted<string>, repo: string) => Effect.Effect<void, GitHubError>
  /** Proves that the repository has the commit. */
  readonly checkCommit: (token: Redacted.Redacted<string>, repo: string, sha: string) => Effect.Effect<void, GitHubError>
  /** The first 100 pull requests in the repository that the search text matches. */
  readonly searchPullRequests: (
    token: Redacted.Redacted<string>,
    repo: string,
    search: string
  ) => Effect.Effect<ReadonlyArray<PullRequest>, GitHubError>
  /** The newest 100 commits to the path since the ISO time, newest first. */
  readonly commits: (
    token: Redacted.Redacted<string>,
    repo: string,
    path: string,
    since: string
  ) => Effect.Effect<ReadonlyArray<Commit>, GitHubError>
  /** The newest `releasesChecked` releases, newest first. */
  readonly releases: (token: Redacted.Redacted<string>, repo: string) => Effect.Effect<ReadonlyArray<Release>, GitHubError>
  /** Whether the tag's history contains the commit. */
  readonly contains: (
    token: Redacted.Redacted<string>,
    repo: string,
    sha: string,
    tag: string
  ) => Effect.Effect<boolean, GitHubError>
}>()("@exangelos/connector-jira/GitHub") {}

const Login = Schema.NullOr(Schema.Struct({ login: Schema.String }))

const SearchWire = Schema.Struct({
  items: Schema.Array(Schema.Struct({
    number: Schema.Finite,
    title: Schema.String,
    state: Schema.String,
    html_url: Schema.String,
    updated_at: Schema.String,
    user: Schema.optionalKey(Login),
    pull_request: Schema.optionalKey(Schema.Struct({ merged_at: Schema.optionalKey(Schema.NullOr(Schema.String)) }))
  }))
})

const CommitsWire = Schema.Array(Schema.Struct({
  sha: Schema.String,
  html_url: Schema.String,
  author: Schema.optionalKey(Login),
  commit: Schema.Struct({
    message: Schema.String,
    author: Schema.optionalKey(Schema.NullOr(Schema.Struct({ name: Schema.optionalKey(Schema.String) }))),
    committer: Schema.optionalKey(Schema.NullOr(Schema.Struct({ date: Schema.optionalKey(Schema.String) })))
  })
}))

const ReleasesWire = Schema.Array(Schema.Struct({
  tag_name: Schema.String,
  html_url: Schema.String,
  published_at: Schema.optionalKey(Schema.NullOr(Schema.String))
}))

const CompareWire = Schema.Struct({ status: Schema.String })

const Anything = Schema.Unknown

const segment = encodeURIComponent

const repoPath = (repo: string) => {
  const [owner = "", name = ""] = repo.split("/")
  return `/repos/${segment(owner)}/${segment(name)}`
}

const rateLimited = (response: HttpClientResponse.HttpClientResponse) =>
  response.status === 429 ||
  Option.getOrUndefined(Headers.get(response.headers, "x-ratelimit-remaining")) === "0" ||
  Option.isSome(Headers.get(response.headers, "retry-after"))

export const layer = Layer.effect(
  GitHub,
  Effect.gen(function*() {
    const http = yield* HttpClient.HttpClient

    const get = <S extends Schema.Top & { readonly DecodingServices: never }>(
      token: Redacted.Redacted<string>,
      path: string,
      urlParams: Record<string, string>,
      schema: S
    ): Effect.Effect<S["Type"], GitHubError> =>
      Effect.gen(function*() {
        const request = HttpClientRequest.get(`${api}${path}`, { urlParams }).pipe(
          HttpClientRequest.bearerToken(Redacted.value(token)),
          HttpClientRequest.acceptJson,
          HttpClientRequest.setHeaders({ "x-github-api-version": "2022-11-28", "user-agent": "exangelos-jira" })
        )
        const response = yield* http.execute(request).pipe(
          Effect.mapError((error) => new GitHubFailure({ reason: `No answer from GitHub (${error.reason._tag}).` }))
        )
        const status = response.status
        if (status === 401) return yield* new GitHubRejected({ status })
        if (status === 403 || status === 429) {
          return yield* rateLimited(response) ? new GitHubRateLimited() : new GitHubRejected({ status })
        }
        if (status === 404 || status === 422) return yield* new GitHubNotFound({ path })
        if (status < 200 || status >= 300) {
          return yield* new GitHubFailure({ reason: `GitHub answered ${status} for ${path}.` })
        }
        const body = yield* response.json.pipe(
          Effect.mapError(() => new GitHubFailure({ reason: `GitHub sent a body that is not JSON for ${path}.` }))
        )
        return yield* Schema.decodeUnknownEffect(schema)(body).pipe(
          Effect.mapError(() => new GitHubFailure({ reason: `GitHub answered ${path} with an unexpected shape.` }))
        )
      })

    return {
      checkRepository: (token, repo) => get(token, repoPath(repo), {}, Anything).pipe(Effect.asVoid),

      checkCommit: (token, repo, sha) => get(token, `${repoPath(repo)}/commits/${segment(sha)}`, {}, Anything).pipe(Effect.asVoid),

      searchPullRequests: (token, repo, search) =>
        get(token, "/search/issues", { q: `${search} repo:${repo} is:pr`, per_page: "100" }, SearchWire).pipe(
          Effect.map(({ items }) =>
            items.map((item): PullRequest => ({
              number: item.number,
              title: item.title,
              state: item.pull_request?.merged_at != null ? "merged" : item.state === "open" ? "open" : "closed",
              url: item.html_url,
              author: item.user?.login ?? null,
              updatedAt: item.updated_at
            }))
          )
        ),

      commits: (token, repo, path, since) =>
        get(token, `${repoPath(repo)}/commits`, { path, since, per_page: "100" }, CommitsWire).pipe(
          Effect.map((items) =>
            items.map((item): Commit => ({
              sha: item.sha,
              message: item.commit.message.split("\n", 1)[0] ?? "",
              url: item.html_url,
              author: item.author?.login ?? item.commit.author?.name ?? null,
              date: item.commit.committer?.date ?? ""
            }))
          )
        ),

      releases: (token, repo) =>
        get(token, `${repoPath(repo)}/releases`, { per_page: String(releasesChecked) }, ReleasesWire).pipe(
          Effect.map((items) =>
            items.map((item): Release => ({ tag: item.tag_name, url: item.html_url, publishedAt: item.published_at ?? null }))
          )
        ),

      contains: (token, repo, sha, tag) =>
        get(token, `${repoPath(repo)}/compare/${segment(sha)}...${segment(tag)}`, {}, CompareWire).pipe(
          Effect.map(({ status }) => status === "ahead" || status === "identical")
        )
    }
  })
)
