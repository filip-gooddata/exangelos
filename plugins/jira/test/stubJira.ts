import { Effect, Layer, Option } from "effect"
import { layer } from "../src/JiraClient.ts"
import { HttpClient, HttpClientResponse, UrlParams } from "effect/http"
import type { HttpClientRequest } from "effect/http"

export interface StubAnswer {
  readonly status: number
  readonly body?: unknown
  readonly headers?: Record<string, string>
}

export interface StubCall {
  readonly path: string
  readonly param: (name: string) => string | undefined
  readonly request: HttpClientRequest.HttpClientRequest
}

/** An HttpClient layer that answers each request from `answer` and never reaches the network. */
export const stubJira = (answer: (call: StubCall) => StubAnswer) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      const path = request.url.replace(/^https:\/\/[^/]+/, "").split("?")[0] ?? ""
      const param = (name: string) => Option.getOrUndefined(UrlParams.getFirst(request.urlParams, name))
      const reply = answer({ path, param, request })
      const init = reply.headers === undefined ? { status: reply.status } : { status: reply.status, headers: reply.headers }
      return Effect.succeed(
        HttpClientResponse.fromWeb(request, new Response(JSON.stringify(reply.body ?? {}), init))
      )
    })
  )

export const person = (name: string) => ({ accountId: `id-${name}`, displayName: name })

export const history = (id: number, created: string, items: ReadonlyArray<Record<string, unknown>>) => ({
  id: String(id),
  created,
  author: person("Mia"),
  items
})

export const comment = (id: number, created: string, text: string) => ({
  id: String(id),
  created,
  author: person("Ana"),
  body: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text }] }] }
})

/** Serves an oldest-first list `pageSize` items at a time, honouring startAt, as Jira does. */
export const page = <A>(all: ReadonlyArray<A>, startAt: number, pageSize: number) =>
  ({ startAt, total: all.length, items: all.slice(startAt, startAt + pageSize) })

/** The real JiraClient over the stub. */
export const jiraWith = (answer: (call: StubCall) => StubAnswer) => Layer.provide(layer, stubJira(answer))
