import { Effect, Layer, Ref } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"

export interface Answer {
  readonly status: number
  readonly body: unknown
  readonly headers?: Record<string, string>
}

export interface Sent {
  readonly url: string
  readonly authorization: string | undefined
  readonly query: string
  readonly variables: Record<string, unknown>
}

const quota = {
  "x-ratelimit-limit": "5000",
  "x-ratelimit-remaining": "4999",
  "x-ratelimit-used": "1",
  "x-ratelimit-reset": "1794484800",
  "x-ratelimit-resource": "graphql"
}

export const ok = (data: unknown, headers: Record<string, string> = {}): Answer => ({
  status: 200,
  body: { data },
  headers: { ...quota, ...headers }
})

export const badCredentials: Answer = {
  status: 401,
  body: { message: "Bad credentials", documentation_url: "https://docs.github.com/rest", status: "401" }
}

export const notFound = (owner: string, repo: string): Answer => ({
  status: 200,
  headers: quota,
  body: {
    data: { repository: null },
    errors: [{
      type: "NOT_FOUND",
      path: ["repository"],
      locations: [{ line: 3, column: 3 }],
      message: `Could not resolve to a Repository with the name '${owner}/${repo}'.`
    }]
  }
})

export const secondaryLimit: Answer = {
  status: 403,
  headers: { "retry-after": "30" },
  body: {
    message: "You have exceeded a secondary rate limit. Please wait a few minutes before you try again.",
    documentation_url: "https://docs.github.com/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api"
  }
}

const page = (nodes: ReadonlyArray<unknown>, startCursor: string | null = null) => ({
  pageInfo: { hasPreviousPage: startCursor !== null, startCursor },
  nodes
})

type CommentFields = { readonly id: string; readonly login: string; readonly body: string; readonly createdAt: string }

const commentNode = (c: CommentFields) => ({
  id: c.id,
  body: c.body,
  createdAt: c.createdAt,
  url: `https://github.com/acme/api/pull/7#issuecomment-${c.id}`,
  author: { login: c.login }
})

type ThreadCommentFields = {
  readonly id: string
  readonly login: string
  readonly createdAt: string
  readonly review?: string
}

const threadCommentNode = (c: ThreadCommentFields) => ({
  id: c.id,
  body: `note ${c.id}`,
  createdAt: c.createdAt,
  publishedAt: c.createdAt,
  state: "SUBMITTED",
  url: `https://github.com/acme/api/pull/7#discussion_${c.id}`,
  author: { login: c.login },
  pullRequestReview: c.review === undefined ? null : { id: c.review }
})

type ReviewFields = { readonly id: string; readonly login: string; readonly body: string; readonly submittedAt: string }

const reviewNode = (r: ReviewFields) => ({
  id: r.id,
  state: "COMMENTED",
  body: r.body,
  submittedAt: r.submittedAt,
  url: `https://github.com/acme/api/pull/7#pullrequestreview-${r.id}`,
  author: { login: r.login },
  commit: { oid: "a".repeat(40) }
})

export interface ThreadFields {
  readonly id: string
  readonly comments: ReadonlyArray<ThreadCommentFields>
  readonly olderReplies?: string
}

export interface PullRequestFields {
  readonly state?: "OPEN" | "CLOSED" | "MERGED"
  readonly isDraft?: boolean
  readonly threads?: ReadonlyArray<ThreadFields>
  readonly olderThreads?: string
  readonly requested?: ReadonlyArray<string>
  readonly requests?: ReadonlyArray<RequestFields>
  readonly olderTimeline?: string
  readonly head?: string
  readonly mergeable?: "MERGEABLE" | "CONFLICTING" | "UNKNOWN"
  readonly reviewDecision?: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null
  readonly comments?: ReadonlyArray<CommentFields>
  readonly olderComments?: string
  readonly reviews?: ReadonlyArray<ReviewFields>
  readonly headers?: Record<string, string>
  readonly checks?: ReadonlyArray<{ readonly id: string; readonly name: string; readonly conclusion: string | null }>
}

type RequestFields = { readonly id: string; readonly login: string; readonly createdAt: string }

const requestNode = (r: RequestFields) => ({
  __typename: "ReviewRequestedEvent",
  id: r.id,
  createdAt: r.createdAt,
  requestedReviewer: { __typename: "User", login: r.login }
})

export const timelinePage = (requests: ReadonlyArray<RequestFields>, older: string | null) =>
  ok({ repository: { pullRequest: { timelineItems: page(requests.map(requestNode), older) } } })

const threadNode = (t: ThreadFields) => ({
  id: t.id,
  isResolved: false,
  path: "src/retry.ts",
  opener: { nodes: t.comments.slice(0, 1).map(threadCommentNode) },
  replies: page(t.comments.map(threadCommentNode), t.olderReplies ?? null)
})

export const threadsPage = (threads: ReadonlyArray<ThreadFields>, older: string | null) =>
  ok({ repository: { pullRequest: { reviewThreads: page(threads.map(threadNode), older) } } })

export const pullRequest = (fields: PullRequestFields = {}): Answer =>
  ok({
    repository: {
      pullRequest: {
        url: "https://github.com/acme/api/pull/7",
        title: "Add retries",
        state: fields.state ?? "OPEN",
        isDraft: fields.isDraft ?? false,
        mergedAt: fields.state === "MERGED" ? "2026-11-12T12:00:00Z" : null,
        closedAt: fields.state === undefined || fields.state === "OPEN" ? null : "2026-11-12T12:00:00Z",
        author: { login: "olga" },
        headRefOid: fields.head ?? "a".repeat(40),
        baseRefName: "main",
        baseRefOid: "b".repeat(40),
        mergeable: fields.mergeable ?? "MERGEABLE",
        mergeStateStatus: "BLOCKED",
        reviewDecision: fields.reviewDecision === undefined ? "REVIEW_REQUIRED" : fields.reviewDecision,
        baseRef: {
          refUpdateRule: { requiredStatusCheckContexts: ["build"] },
          branchProtectionRule: null
        },
        reviewRequests: { nodes: (fields.requested ?? []).map((login) => ({ requestedReviewer: { __typename: "User", login } })) },
        reviewerReviews: { nodes: [] },
        reviews: page((fields.reviews ?? []).map(reviewNode)),
        comments: page((fields.comments ?? []).map(commentNode), fields.olderComments ?? null),
        reviewThreads: page((fields.threads ?? []).map(threadNode), fields.olderThreads ?? null),
        timelineItems: page((fields.requests ?? []).map(requestNode), fields.olderTimeline ?? null),
        commits: {
          nodes: [{
            commit: {
              statusCheckRollup: {
                contexts: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: (fields.checks ?? []).map((c) => ({
                    __typename: "CheckRun",
                    id: c.id,
                    name: c.name,
                    status: c.conclusion === null ? "IN_PROGRESS" : "COMPLETED",
                    conclusion: c.conclusion,
                    completedAt: c.conclusion === null ? null : "2026-11-12T11:30:00Z",
                    detailsUrl: `https://github.com/acme/api/actions/runs/${c.id}`,
                    isRequired: c.name === "build"
                  }))
                }
              }
            }
          }]
        }
      }
    }
  }, fields.headers)

export const commentsPage = (comments: ReadonlyArray<CommentFields>, older: string | null, headers?: Record<string, string>) =>
  ok({ repository: { pullRequest: { comments: page(comments.map(commentNode), older) } } }, headers)

export const threadReplies = (comments: ReadonlyArray<ThreadCommentFields>, older: string | null) =>
  ok({ node: { comments: page(comments.map(threadCommentNode), older) } })

export const viewer = ok({ viewer: { login: "octocat" } })

const WebResponse = (globalThis as unknown as {
  readonly Response: new(
    body: string,
    init: { readonly status: number; readonly headers: Record<string, string> }
  ) => Parameters<typeof HttpClientResponse.fromWeb>[1]
}).Response

export const make = (answers: ReadonlyArray<Answer>) =>
  Effect.gen(function*() {
    const sent = yield* Ref.make<ReadonlyArray<Sent>>([])
    const remaining = yield* Ref.make(answers)
    const client = HttpClient.make((request, url) =>
      Effect.gen(function*() {
        const body = request.body._tag === "Uint8Array" ? JSON.parse(String.fromCharCode(...request.body.body)) : {}
        yield* Ref.update(sent, (all) => [...all, {
          url: url.toString(),
          authorization: request.headers["authorization"],
          query: body.query,
          variables: body.variables
        }])
        const answer = yield* Ref.modify(remaining, (all) => [all[0]!, all.length > 1 ? all.slice(1) : all])
        return HttpClientResponse.fromWeb(
          request,
          new WebResponse(JSON.stringify(answer.body), {
            status: answer.status,
            headers: { "content-type": "application/json", ...answer.headers }
          })
        )
      })
    )
    return { layer: Layer.succeed(HttpClient.HttpClient, client), sent: Ref.get(sent) }
  })
