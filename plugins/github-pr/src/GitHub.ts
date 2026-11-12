import { Clock, Context, Data, Duration, Effect, Layer, Option, Redacted, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import type { PullRequestRef } from "./PullRequestRef.ts"
import * as Query from "./Query.ts"
import type { Check, CheckOutcome, Snapshot } from "./Snapshot.ts"

export interface Connection {
  /** `github.com` or a GitHub Enterprise Server host name. */
  readonly host: string
  readonly token: Redacted.Redacted<string>
}

/** The token was refused, or it may not read what the query asks for. */
export class Unauthorized extends Data.TaggedError("Unauthorized")<{ readonly reason: string }> {}

/** GitHub answers the same for a missing repository and one the token may not see. */
export class NotFound extends Data.TaggedError("NotFound")<{ readonly reason: string }> {}

export class RateLimited extends Data.TaggedError("RateLimited")<{ readonly retryAfter: Duration.Duration }> {}

export class Unavailable extends Data.TaggedError("Unavailable")<{ readonly reason: string }> {}

export type GitHubError = Unauthorized | NotFound | RateLimited | Unavailable

/** The primary quota as the last response reported it. */
export interface Quota {
  readonly remaining: number
  readonly resetAt: number
}

/**
 * The creation time of the newest review, comment and thread the last poll
 * saw, so paging stops once it reaches them. Without it only the newest page
 * of each is read.
 */
export interface Since {
  readonly reviews: string | null
  readonly comments: string | null
  readonly threads: string | null
}

export const endpoint = (host: string) =>
  host === "github.com" ? "https://api.github.com/graphql" : `https://${host}/api/graphql`

const Login = Schema.NullOr(Schema.Struct({ login: Schema.String }))
const Backward = Schema.Struct({ hasPreviousPage: Schema.Boolean, startCursor: Schema.NullOr(Schema.String) })

const ReviewNode = Schema.Struct({
  id: Schema.String,
  state: Schema.String,
  body: Schema.String,
  submittedAt: Schema.NullOr(Schema.String),
  url: Schema.String,
  author: Login
})
const CommentNode = Schema.Struct({
  id: Schema.String,
  body: Schema.String,
  createdAt: Schema.String,
  url: Schema.String,
  author: Login
})
const ThreadNode = Schema.Struct({
  id: Schema.String,
  isResolved: Schema.Boolean,
  path: Schema.String,
  comments: Schema.Struct({
    nodes: Schema.Array(Schema.Struct({ body: Schema.String, createdAt: Schema.String, url: Schema.String, author: Login }))
  })
})
const ContextNode = Schema.Union([
  Schema.Struct({
    __typename: Schema.Literal("CheckRun"),
    id: Schema.String,
    name: Schema.String,
    status: Schema.String,
    conclusion: Schema.NullOr(Schema.String),
    completedAt: Schema.NullOr(Schema.String),
    detailsUrl: Schema.NullOr(Schema.String),
    isRequired: Schema.Boolean
  }),
  Schema.Struct({
    __typename: Schema.Literal("StatusContext"),
    id: Schema.String,
    context: Schema.String,
    state: Schema.String,
    createdAt: Schema.String,
    targetUrl: Schema.NullOr(Schema.String),
    isRequired: Schema.Boolean
  })
])

const backward = <S extends Schema.Top>(node: S) => Schema.Struct({ pageInfo: Backward, nodes: Schema.Array(node) })
const Contexts = Schema.Struct({
  pageInfo: Schema.Struct({ hasNextPage: Schema.Boolean, endCursor: Schema.NullOr(Schema.String) }),
  nodes: Schema.Array(ContextNode)
})
const Commits = Schema.Struct({
  nodes: Schema.Array(Schema.Struct({
    commit: Schema.Struct({ statusCheckRollup: Schema.NullOr(Schema.Struct({ contexts: Contexts })) })
  }))
})

const Connections = {
  reviews: Schema.optionalKey(backward(ReviewNode)),
  comments: Schema.optionalKey(backward(CommentNode)),
  reviewThreads: Schema.optionalKey(backward(ThreadNode)),
  commits: Schema.optionalKey(Commits)
}

const PullRequestNode = Schema.Struct({
  url: Schema.String,
  title: Schema.String,
  state: Schema.Literals(["OPEN", "CLOSED", "MERGED"]),
  isDraft: Schema.Boolean,
  mergedAt: Schema.NullOr(Schema.String),
  closedAt: Schema.NullOr(Schema.String),
  headRefOid: Schema.String,
  baseRefName: Schema.String,
  baseRefOid: Schema.String,
  mergeable: Schema.Literals(["MERGEABLE", "CONFLICTING", "UNKNOWN"]),
  reviewDecision: Schema.NullOr(Schema.Literals(["APPROVED", "CHANGES_REQUESTED", "REVIEW_REQUIRED"])),
  baseRef: Schema.NullOr(Schema.Struct({
    refUpdateRule: Schema.NullOr(Schema.Struct({ requiredStatusCheckContexts: Schema.NullOr(Schema.Array(Schema.String)) })),
    branchProtectionRule: Schema.NullOr(
      Schema.Struct({ requiredStatusCheckContexts: Schema.NullOr(Schema.Array(Schema.String)) })
    )
  })),
  ...Connections
})

const GraphQLError = Schema.Struct({ type: Schema.optionalKey(Schema.String), message: Schema.String })

const answer = <S extends Schema.Codec<any, unknown>>(data: S) =>
  Schema.Struct({
    data: Schema.optionalKey(Schema.NullOr(data)),
    errors: Schema.optionalKey(Schema.Array(GraphQLError))
  })

const PullRequestData = Schema.Struct({
  repository: Schema.NullOr(Schema.Struct({ pullRequest: Schema.NullOr(PullRequestNode) }))
})
const ConnectionsNode = Schema.Struct(Connections)
const PagesData = Schema.Struct({
  repository: Schema.NullOr(Schema.Struct({ pullRequest: Schema.NullOr(ConnectionsNode) }))
})
const Viewer = Schema.Struct({ viewer: Schema.Struct({ login: Schema.String }) })

const ErrorMessage = Schema.Struct({ message: Schema.String })

const header = (headers: Readonly<Record<string, string | undefined>>, name: string) => {
  const value = Number(headers[name])
  return headers[name] === undefined || !Number.isFinite(value) ? undefined : value
}

const quotaOf = (headers: Readonly<Record<string, string | undefined>>): Option.Option<Quota> => {
  const remaining = header(headers, "x-ratelimit-remaining")
  const reset = header(headers, "x-ratelimit-reset")
  return remaining === undefined || reset === undefined ? Option.none() : Option.some({ remaining, resetAt: reset * 1000 })
}

/** How long a refusal asks to wait: `retry-after`, else the quota reset, else a minute. */
const waitOf = (headers: Readonly<Record<string, string | undefined>>, now: number) => {
  const retryAfter = header(headers, "retry-after")
  if (retryAfter !== undefined) return Duration.seconds(retryAfter)
  const quota = quotaOf(headers)
  if (Option.isSome(quota) && quota.value.remaining === 0) return Duration.millis(Math.max(quota.value.resetAt - now, 1000))
  return Duration.minutes(1)
}

const outcome = (node: typeof ContextNode.Type): CheckOutcome => {
  if (node.__typename === "CheckRun") {
    if (node.status !== "COMPLETED") return "pending"
    if (node.conclusion === "SUCCESS" || node.conclusion === "NEUTRAL" || node.conclusion === "SKIPPED") return "passed"
    return node.conclusion === "CANCELLED" ? "cancelled" : "failed"
  }
  if (node.state === "SUCCESS") return "passed"
  return node.state === "FAILURE" || node.state === "ERROR" ? "failed" : "pending"
}

const toCheck = (node: typeof ContextNode.Type): Check =>
  node.__typename === "CheckRun"
    ? {
      id: node.id,
      kind: "run",
      name: node.name,
      outcome: outcome(node),
      required: node.isRequired,
      url: node.detailsUrl,
      completedAt: node.completedAt
    }
    : {
      id: node.id,
      kind: "status",
      name: node.context,
      outcome: outcome(node),
      required: node.isRequired,
      url: node.targetUrl,
      completedAt: outcome(node) === "pending" ? null : node.createdAt
    }

const author = (login: typeof Login.Type) => login?.login ?? "ghost"

type Nodes = {
  reviews: Array<typeof ReviewNode.Type>
  comments: Array<typeof CommentNode.Type>
  threads: Array<typeof ThreadNode.Type>
  checks: Array<typeof ContextNode.Type>
}

export interface Fetched {
  readonly snapshot: Snapshot
  readonly quota: Option.Option<Quota>
}

export class GitHub extends Context.Service<GitHub, {
  /** Checks the token by asking who it belongs to. */
  readonly viewer: (connection: Connection) => Effect.Effect<string, GitHubError>
  readonly pullRequest: (
    connection: Connection,
    ref: PullRequestRef,
    since: Since | undefined
  ) => Effect.Effect<Fetched, GitHubError>
}>()("@exangelos/plugin-github-pr/GitHub") {}

export const layer = Layer.effect(
  GitHub,
  Effect.gen(function*() {
    const client = yield* HttpClient.HttpClient

    const post = <S extends Schema.Codec<any, unknown>>(
      connection: Connection,
      data: S,
      query: string,
      variables: Record<string, unknown>
    ): Effect.Effect<{ readonly data: S["Type"]; readonly quota: Option.Option<Quota> }, GitHubError> =>
      Effect.gen(function*() {
        const request = HttpClientRequest.post(endpoint(connection.host)).pipe(
          HttpClientRequest.bearerToken(Redacted.value(connection.token)),
          HttpClientRequest.acceptJson,
          HttpClientRequest.setHeader("user-agent", "exangelos-github-pr"),
          HttpClientRequest.bodyJsonUnsafe({ query, variables })
        )
        const response = yield* client.execute(request).pipe(
          Effect.mapError(() => new Unavailable({ reason: `Could not reach ${connection.host}` }))
        )
        const now = yield* Clock.currentTimeMillis
        const secret = Redacted.value(connection.token)
        // A server or proxy could echo the token in a message; none leaves this function with it.
        const scrub = (text: string) => secret === "" ? text : text.replaceAll(secret, "[token]")
        const message = response.json.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(ErrorMessage)),
          Effect.map((body) => scrub(body.message)),
          Effect.orElseSucceed(() => `HTTP ${response.status}`)
        )
        if (response.status === 401) {
          return yield* new Unauthorized({ reason: `GitHub refused the token: ${yield* message}` })
        }
        if (response.status === 429 || (response.status === 403 && /rate limit/i.test(yield* message))) {
          return yield* new RateLimited({ retryAfter: waitOf(response.headers, now) })
        }
        if (response.status === 403) {
          return yield* new Unauthorized({ reason: `GitHub refused access: ${yield* message}` })
        }
        if (response.status !== 200) {
          return yield* new Unavailable({ reason: `GitHub answered ${response.status}: ${yield* message}` })
        }
        const body = yield* response.json.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(answer(data))),
          Effect.mapError(() => new Unavailable({ reason: "GitHub sent an answer this plugin cannot read" }))
        )
        const first = body.errors?.[0]
        const error = first === undefined ? undefined : { ...first, message: scrub(first.message) }
        if (error !== undefined) {
          if (error.type === "RATE_LIMITED") return yield* new RateLimited({ retryAfter: waitOf(response.headers, now) })
          if (error.type === "NOT_FOUND") return yield* new NotFound({ reason: error.message })
          if (error.type === "FORBIDDEN" || error.type === "INSUFFICIENT_SCOPES") {
            return yield* new Unauthorized({ reason: error.message })
          }
          return yield* new Unavailable({ reason: error.message })
        }
        if (body.data == null) return yield* new Unavailable({ reason: "GitHub sent no data" })
        return { data: body.data, quota: quotaOf(response.headers) }
      })

    const viewer = (connection: Connection) =>
      post(connection, Viewer, Query.viewer, {}).pipe(Effect.map(({ data }) => data.viewer.login))

    const pullRequest = (connection: Connection, ref: PullRequestRef, since: Since | undefined) =>
      Effect.gen(function*() {
        const variables = { owner: ref.owner, repo: ref.repo, number: ref.number }
        const notFound = new NotFound({ reason: `No pull request ${ref.owner}/${ref.repo}#${ref.number}` })
        const first = yield* post(connection, PullRequestData, Query.pullRequest, variables)
        const pr = first.data.repository?.pullRequest
        if (pr == null) return yield* notFound

        const nodes: Nodes = { reviews: [], comments: [], threads: [], checks: [] }
        let quota = first.quota
        const older = <N>(
          key: "reviews" | "comments" | "threads",
          page: { readonly pageInfo: typeof Backward.Type; readonly nodes: ReadonlyArray<N> } | undefined,
          into: Array<N>,
          at: (node: N) => string | null,
          pending: Partial<Record<Query.Connection, string>>
        ) => {
          if (page === undefined) return
          into.unshift(...page.nodes)
          const mark = since?.[key] ?? null
          const oldest = page.nodes[0] === undefined ? null : at(page.nodes[0])
          const reachedMark = mark !== null && oldest !== null && oldest < mark
          if (since !== undefined && page.pageInfo.hasPreviousPage && page.pageInfo.startCursor && !reachedMark) {
            pending[key] = page.pageInfo.startCursor
          }
        }

        const collect = (connections: typeof ConnectionsNode.Type) => {
          const pending: Partial<Record<Query.Connection, string>> = {}
          older("reviews", connections.reviews, nodes.reviews, (n) => n.submittedAt, pending)
          older("comments", connections.comments, nodes.comments, (n) => n.createdAt, pending)
          older("threads", connections.reviewThreads, nodes.threads, (n) => n.comments.nodes[0]?.createdAt ?? null, pending)
          const contexts = connections.commits?.nodes[0]?.commit.statusCheckRollup?.contexts
          if (contexts !== undefined) {
            nodes.checks.push(...contexts.nodes)
            if (contexts.pageInfo.hasNextPage && contexts.pageInfo.endCursor) pending.checks = contexts.pageInfo.endCursor
          }
          return pending
        }

        let next = collect(pr)
        // Paging back stops at what the last poll saw, so even a long pause ends in a bounded number of pages.
        while (Object.keys(next).length > 0) {
          if (Option.isSome(quota) && quota.value.remaining === 0) {
            const now = yield* Clock.currentTimeMillis
            yield* Effect.sleep(Duration.millis(Math.max(quota.value.resetAt - now, 0)))
          }
          const connections = Object.keys(next) as Array<Query.Connection>
          const request = post(connection, PagesData, Query.morePages(connections), { ...variables, ...next })
          // A secondary limit mid-catch-up waits and asks for the same page, keeping the pages already read.
          const more = yield* request.pipe(
            Effect.catchTag("RateLimited", ({ retryAfter }) => Effect.sleep(retryAfter).pipe(Effect.andThen(request))),
            Effect.catchTag("RateLimited", ({ retryAfter }) => Effect.sleep(retryAfter).pipe(Effect.andThen(request)))
          )
          quota = Option.orElse(more.quota, () => quota)
          const again = more.data.repository?.pullRequest
          if (again == null) return yield* notFound
          next = collect(again)
        }

        const rules = [
          ...(pr.baseRef?.refUpdateRule?.requiredStatusCheckContexts ?? []),
          ...(pr.baseRef?.branchProtectionRule?.requiredStatusCheckContexts ?? [])
        ]
        const snapshot: Snapshot = {
          url: pr.url,
          title: pr.title,
          state: pr.state,
          isDraft: pr.isDraft,
          mergedAt: pr.mergedAt,
          closedAt: pr.closedAt,
          head: pr.headRefOid,
          base: { name: pr.baseRefName, oid: pr.baseRefOid },
          mergeable: pr.mergeable,
          reviewDecision: pr.reviewDecision,
          checks: nodes.checks.map(toCheck),
          requiredChecks: [...new Set(rules)],
          reviews: nodes.reviews.flatMap((n) =>
            n.submittedAt === null ? [] : [{
              id: n.id,
              author: author(n.author),
              state: n.state,
              body: n.body,
              submittedAt: n.submittedAt,
              url: n.url
            }]
          ),
          comments: nodes.comments.map((n) => ({
            id: n.id,
            author: author(n.author),
            body: n.body,
            createdAt: n.createdAt,
            url: n.url
          })),
          threads: nodes.threads.flatMap((n) => {
            const opening = n.comments.nodes[0]
            return opening === undefined ? [] : [{
              id: n.id,
              isResolved: n.isResolved,
              path: n.path,
              author: author(opening.author),
              body: opening.body,
              createdAt: opening.createdAt,
              url: opening.url
            }]
          })
        }
        return { snapshot, quota }
      })

    return GitHub.of({ viewer, pullRequest })
  })
)
