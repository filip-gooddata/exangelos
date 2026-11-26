import { Effect, Layer, Ref } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"

export interface Answer {
  readonly status: number
  readonly body: unknown
  readonly headers?: Record<string, string>
}

export interface Sent {
  readonly method: string
  readonly url: string
  readonly authorization: string | undefined
  readonly ifNoneMatch: string | undefined
  readonly query: string | undefined
  readonly variables: Record<string, unknown> | undefined
}

const quota = { "x-ratelimit-remaining": "4999", "x-ratelimit-reset": "1794484800" }

export const ok = (data: unknown): Answer => ({ status: 200, body: { data }, headers: quota })

export const viewer = ok({ viewer: { login: "octocat" } })

export const secondaryLimit: Answer = {
  status: 403,
  headers: { "retry-after": "30" },
  body: { message: "You have exceeded a secondary rate limit. Please wait a few minutes before you try again." }
}

export const restSecondaryLimit: Answer = {
  status: 403,
  headers: { "retry-after": "30" },
  body: { message: "You have exceeded a secondary rate limit." }
}

export const actionsForbidden: Answer = {
  status: 403,
  headers: quota,
  body: { message: "Resource not accessible by personal access token" }
}

export const badCredentials: Answer = { status: 401, body: { message: "Bad credentials" } }

export const notFound: Answer = {
  status: 200,
  headers: quota,
  body: {
    data: { repository: null },
    errors: [{ type: "NOT_FOUND", message: "Could not resolve to a Repository with the name 'acme/api'." }]
  }
}

const refNode = (name: string, sha: string, annotated: boolean) => ({
  name,
  target: annotated ? { oid: `tag-object-of-${sha}`, target: { oid: sha } } : { oid: sha }
})

export const refs = (
  entries: Record<string, string>,
  options: { readonly annotated?: boolean; readonly next?: string } = {}
) => ({
  pageInfo: { hasNextPage: options.next !== undefined, endCursor: options.next ?? null },
  nodes: Object.entries(entries).map(([name, sha]) => refNode(name, sha, options.annotated ?? false))
})

export interface ReleaseFields {
  readonly id: number
  readonly tag: string
  readonly publishedAt: string | null
  readonly draft?: boolean
}

export const releases = (list: ReadonlyArray<ReleaseFields>) => ({
  nodes: list.map((r) => ({
    databaseId: r.id,
    tagName: r.tag,
    name: null,
    url: `https://github.com/acme/api/releases/tag/${r.tag}`,
    isDraft: r.draft ?? false,
    isPrerelease: false,
    publishedAt: r.publishedAt
  }))
})

/** A Snapshot query answer: aliases such as `t0` and `b0` to ref pages, and `releases`. */
export const repository = (parts: Record<string, unknown>, date?: string): Answer => {
  const answer = ok({ repository: parts })
  return date === undefined ? answer : { ...answer, headers: { ...answer.headers, date } }
}

export const refsPage = (page: unknown) => ok({ repository: { refs: page } })

export interface RunFields {
  readonly id: number
  readonly attempt?: number
  readonly conclusion: string | null
  readonly updatedAt: string
}

export const runs = (list: ReadonlyArray<RunFields>, etag = `"e${list.map((r) => r.id).join("-")}"`): Answer => ({
  status: 200,
  headers: { ...quota, etag },
  body: {
    total_count: list.length,
    workflow_runs: list.map((r) => ({
      id: r.id,
      run_attempt: r.attempt ?? 1,
      run_number: r.id,
      name: "Publish",
      status: r.conclusion === null ? "in_progress" : "completed",
      conclusion: r.conclusion,
      head_branch: "release/mic/4.45",
      head_sha: "c".repeat(40),
      event: "workflow_dispatch",
      html_url: `https://github.com/acme/api/actions/runs/${r.id}`,
      updated_at: r.updatedAt
    }))
  }
})

export const notModified: Answer = { status: 304, body: "", headers: quota }

const WebResponse = (globalThis as unknown as {
  readonly Response: new(
    body: string | null,
    init: { readonly status: number; readonly headers: Record<string, string> }
  ) => Parameters<typeof HttpClientResponse.fromWeb>[1]
}).Response

/** Answers requests in order; the last answer repeats. */
export const make = (answers: ReadonlyArray<Answer>) =>
  Effect.gen(function*() {
    const sent = yield* Ref.make<ReadonlyArray<Sent>>([])
    const remaining = yield* Ref.make(answers)
    const client = HttpClient.make((request, url) =>
      Effect.gen(function*() {
        const body = request.body._tag === "Uint8Array"
          ? JSON.parse(new TextDecoder().decode(request.body.body))
          : undefined
        yield* Ref.update(sent, (all) => [...all, {
          method: request.method,
          url: url.toString(),
          authorization: request.headers["authorization"],
          ifNoneMatch: request.headers["if-none-match"],
          query: body?.query,
          variables: body?.variables
        }])
        const answer = yield* Ref.modify(remaining, (all) => [all[0]!, all.length > 1 ? all.slice(1) : all])
        return HttpClientResponse.fromWeb(
          request,
          new WebResponse(answer.status === 304 ? null : JSON.stringify(answer.body), {
            status: answer.status,
            headers: { "content-type": "application/json", ...answer.headers }
          })
        )
      })
    )
    return { layer: Layer.succeed(HttpClient.HttpClient, client), sent: Ref.get(sent) }
  })
