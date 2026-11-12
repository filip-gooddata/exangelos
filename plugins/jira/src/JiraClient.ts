import { Context, DateTime, Duration, Effect, Layer, Option, Schema } from "effect"
import { Headers, HttpClient, HttpClientRequest } from "effect/http"
import type { HttpClientError, HttpClientResponse } from "effect/http"
import {
  CredentialRejected,
  DecodeFailure,
  HttpFailure,
  JqlResultTooLarge,
  NotFound,
  RateLimited,
  UnsupportedSite
} from "./JiraError.ts"
import type { JiraError } from "./JiraError.ts"
import type { JiraSite } from "./Site.ts"
import type {
  Comment,
  FieldChange,
  History,
  IssuePosition,
  IssueSnapshot,
  JqlIssue,
  JqlSnapshot,
  ListPosition,
  ListTail,
  Person
} from "./Snapshot.ts"

/** How often a subscription polls when Jira does not ask for longer with Retry-After. */
export const defaultPollInterval = Duration.seconds(60)

/** The most issues a JQL subscription tracks; a larger result fails with JqlResultTooLarge. */
export const membershipLimit = 1000

/** How many items before the cursor's position a poll re-reads, so deletions do not hide new items. */
export const overlap = 50

const pageSize = 100

export class JiraClient extends Context.Service<JiraClient, {
  /** Refuses a site that is not Jira Cloud, probing /rest/api/3/serverInfo. Also proves the credential. */
  readonly checkSite: (site: JiraSite) => Effect.Effect<void, JiraError>
  /**
   * The issue's current fields plus every changelog history and comment from just before
   * `position` to the end. Without a position it reads both lists whole (a baseline).
   */
  readonly readIssue: (input: {
    readonly site: JiraSite
    readonly key: string
    readonly position: IssuePosition | undefined
  }) => Effect.Effect<IssueSnapshot, JiraError>
  /** Every issue the query matches now. Fails with JqlResultTooLarge above `membershipLimit`. */
  readonly readJql: (input: { readonly site: JiraSite; readonly jql: string }) => Effect.Effect<JqlSnapshot, JiraError>
}>()("@exangelos/plugin-jira/JiraClient") {}

const PersonWire = Schema.Struct({
  accountId: Schema.optionalKey(Schema.String),
  displayName: Schema.optionalKey(Schema.String)
})

const ChangelogPageWire = Schema.Struct({
  total: Schema.Finite,
  values: Schema.Array(Schema.Struct({
    id: Schema.String,
    created: Schema.String,
    author: Schema.optionalKey(PersonWire),
    items: Schema.Array(Schema.Struct({
      field: Schema.String,
      fieldId: Schema.optionalKey(Schema.String),
      from: Schema.optionalKey(Schema.NullOr(Schema.String)),
      fromString: Schema.optionalKey(Schema.NullOr(Schema.String)),
      to: Schema.optionalKey(Schema.NullOr(Schema.String)),
      toString: Schema.optionalKey(Schema.NullOr(Schema.String))
    }))
  }))
})

const CommentPageWire = Schema.Struct({
  total: Schema.Finite,
  comments: Schema.Array(Schema.Struct({
    id: Schema.String,
    created: Schema.String,
    author: Schema.optionalKey(PersonWire),
    body: Schema.optionalKey(Schema.Unknown)
  }))
})

const IssueFieldsWire = Schema.Struct({ summary: Schema.optionalKey(Schema.NullOr(Schema.String)) })

const IssueWire = Schema.Struct({
  id: Schema.String,
  key: Schema.String,
  fields: Schema.optionalKey(IssueFieldsWire)
})

const SearchPageWire = Schema.Struct({
  issues: Schema.Array(IssueWire),
  nextPageToken: Schema.optionalKey(Schema.NullOr(Schema.String)),
  isLast: Schema.optionalKey(Schema.Boolean)
})

const ServerInfoWire = Schema.Struct({ deploymentType: Schema.optionalKey(Schema.NullOr(Schema.String)) })

const retryAfterSeconds = (response: HttpClientResponse.HttpClientResponse): number | undefined =>
  Option.match(Headers.get(response.headers, "retry-after"), {
    onNone: () => undefined,
    onSome: (value) => {
      const seconds = Number(value.trim())
      return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined
    }
  })

const transportFailure = (error: HttpClientError.HttpClientError): HttpFailure => {
  const reason = error.reason
  const description = "description" in reason && typeof reason.description === "string" ? `: ${reason.description}` : ""
  return new HttpFailure({ reason: `${reason._tag}${description}` })
}

/** Jira writes offsets as +0000; ISO 8601 parsers want +00:00. */
const parseTime = (value: string): Effect.Effect<DateTime.Utc, DecodeFailure> =>
  Option.match(DateTime.make(value.replace(/([+-]\d{2})(\d{2})$/, "$1:$2")), {
    onNone: () => Effect.fail(new DecodeFailure({ reason: `Jira returned an unreadable time: ${value}` })),
    onSome: (time) => Effect.succeed(DateTime.toUtc(time))
  })

const person = (wire: typeof PersonWire.Type | undefined): Person | undefined =>
  wire === undefined ? undefined : { accountId: wire.accountId, displayName: wire.displayName }

const newerThan = (id: string, lastId: string): boolean => lastId === "" || Number(id) > Number(lastId)

export const layer = Layer.effect(
  JiraClient,
  Effect.gen(function*() {
    const http = yield* HttpClient.HttpClient

    const get = <S extends Schema.Top & { readonly DecodingServices: never }>(
      site: JiraSite,
      path: string,
      urlParams: Record<string, string>,
      schema: S
    ): Effect.Effect<S["Type"], JiraError> =>
      Effect.gen(function*() {
        const request = HttpClientRequest.get(`${site.url}${path}`, { urlParams }).pipe(
          HttpClientRequest.basicAuth(site.email, site.token),
          HttpClientRequest.acceptJson
        )
        const response = yield* http.execute(request).pipe(Effect.mapError(transportFailure))
        const status = response.status
        if (status === 401) return yield* new CredentialRejected({ status })
        if (status === 404) return yield* new NotFound({ path })
        if (status === 429) {
          const seconds = retryAfterSeconds(response)
          return yield* new RateLimited(seconds === undefined ? {} : { retryAfterSeconds: seconds })
        }
        if (status < 200 || status >= 300) {
          return yield* new HttpFailure({ status, reason: `Jira answered ${status} for ${path}.` })
        }
        const body = yield* response.json.pipe(
          Effect.mapError(() => new DecodeFailure({ reason: `Jira sent a body that is not JSON for ${path}.` }))
        )
        return yield* Schema.decodeUnknownEffect(schema)(body).pipe(
          Effect.mapError((error) => new DecodeFailure({ reason: `Unexpected response for ${path}: ${error.message}` }))
        )
      })

    /** Pages an oldest-first list from `start` until Jira reports no more. */
    const readFrom = <A>(
      start: number,
      page: (startAt: number) => Effect.Effect<{ readonly total: number; readonly items: ReadonlyArray<A> }, JiraError>
    ): Effect.Effect<ListTail<A>, JiraError> =>
      Effect.gen(function*() {
        const items: Array<A> = []
        let offset = start
        while (true) {
          const next = yield* page(offset)
          items.push(...next.items)
          offset += next.items.length
          if (next.items.length === 0 || offset >= next.total) return { start, items }
        }
      })

    /**
     * Reads the tail after `position`, re-reading `overlap` items before it. If the tail does not
     * reach back to an item the cursor already saw, items were deleted ahead of the position and
     * the whole list is read again, so nothing new is skipped.
     */
    const readTail = <A extends { readonly id: string }>(
      position: ListPosition | undefined,
      page: (startAt: number) => Effect.Effect<{ readonly total: number; readonly items: ReadonlyArray<A> }, JiraError>
    ): Effect.Effect<ListTail<A>, JiraError> =>
      Effect.gen(function*() {
        if (position === undefined) return yield* readFrom(0, page)
        const start = Math.max(0, position.consumed - overlap)
        const tail = yield* readFrom(start, page)
        const first = tail.items[0]
        const reachesBack = first !== undefined && !newerThan(first.id, position.lastId)
        return start === 0 || reachesBack ? tail : yield* readFrom(0, page)
      })

    const changelogPage = (site: JiraSite, key: string) => (startAt: number) =>
      get(site, `/rest/api/3/issue/${encodeURIComponent(key)}/changelog`, {
        startAt: String(startAt),
        maxResults: String(pageSize)
      }, ChangelogPageWire).pipe(
        Effect.flatMap((wire) =>
          Effect.forEach(wire.values, (history) =>
            Effect.map(parseTime(history.created), (created): History => ({
              id: history.id,
              created,
              author: person(history.author),
              items: history.items.map((item): FieldChange => ({
                field: item.field,
                fieldId: item.fieldId,
                from: item.from ?? null,
                fromString: item.fromString ?? null,
                to: item.to ?? null,
                toString: item.toString ?? null
              }))
            }))).pipe(Effect.map((items) => ({ total: wire.total, items })))
        )
      )

    const commentPage = (site: JiraSite, key: string) => (startAt: number) =>
      get(site, `/rest/api/3/issue/${encodeURIComponent(key)}/comment`, {
        startAt: String(startAt),
        maxResults: String(pageSize),
        orderBy: "created"
      }, CommentPageWire).pipe(
        Effect.flatMap((wire) =>
          Effect.forEach(wire.comments, (comment) =>
            Effect.map(parseTime(comment.created), (created): Comment => ({
              id: comment.id,
              created,
              author: person(comment.author),
              body: comment.body
            }))).pipe(Effect.map((items) => ({ total: wire.total, items })))
        )
      )

    return {
      checkSite: (site) =>
        get(site, "/rest/api/3/serverInfo", {}, ServerInfoWire).pipe(
          Effect.catchTag("NotFound", () =>
            Effect.fail(new UnsupportedSite({ reason: "The site has no Jira Cloud REST API v3." }))),
          Effect.flatMap((info) =>
            info.deploymentType === "Cloud"
              ? Effect.void
              : Effect.fail(new UnsupportedSite({ reason: "Only Jira Cloud is supported; this site is not Cloud." }))
          )
        ),

      readIssue: ({ key, position, site }) =>
        Effect.gen(function*() {
          const issue = yield* get(site, `/rest/api/3/issue/${encodeURIComponent(key)}`, { fields: "summary" }, IssueWire)
          const changelog = yield* readTail(position?.changelog, changelogPage(site, key))
          const comments = yield* readTail(position?.comments, commentPage(site, key))
          return { id: issue.id, key: issue.key, summary: issue.fields?.summary ?? "", changelog, comments }
        }),

      readJql: ({ jql, site }) =>
        Effect.gen(function*() {
          const issues: Array<JqlIssue> = []
          let token: string | undefined
          while (true) {
            const params: Record<string, string> = { jql, fields: "summary", maxResults: String(pageSize) }
            if (token !== undefined) params.nextPageToken = token
            const page = yield* get(site, "/rest/api/3/search/jql", params, SearchPageWire)
            for (const issue of page.issues) {
              issues.push({ id: issue.id, key: issue.key, summary: issue.fields?.summary ?? "" })
            }
            if (issues.length > membershipLimit) return yield* new JqlResultTooLarge({ limit: membershipLimit })
            const nextToken = page.nextPageToken ?? undefined
            if (page.isLast === true || nextToken === undefined || page.issues.length === 0) return { jql, issues }
            token = nextToken
          }
        })
    }
  })
)
