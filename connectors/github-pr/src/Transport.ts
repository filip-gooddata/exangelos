import { Clock, Duration, Effect, Option, Redacted, Schema } from "effect"
import { type HttpClient, HttpClientRequest, type HttpClientResponse } from "effect/http"

export interface Connection {
  readonly host: string
  readonly token: Redacted.Redacted<string>
}

export class Unauthorized extends Schema.TaggedError<Unauthorized>()("Unauthorized", { reason: Schema.String }) {}

export class NotFound extends Schema.TaggedError<NotFound>()("NotFound", { reason: Schema.String }) {}

export class RateLimited extends Schema.TaggedError<RateLimited>()("RateLimited", { retryAfter: Schema.Duration }) {}

export class Unavailable extends Schema.TaggedError<Unavailable>()("Unavailable", { reason: Schema.String }) {}

/** A REST request the token is valid for but may not make, such as reading Actions without that permission. */
export class Forbidden extends Schema.TaggedError<Forbidden>()("Forbidden", { reason: Schema.String }) {}

export type GitHubError = Unauthorized | NotFound | RateLimited | Unavailable

export interface Quota {
  readonly remaining: number
  readonly resetAt: number
}

export const endpoint = (host: string) =>
  host === "github.com" ? "https://api.github.com/graphql" : `https://${host}/api/graphql`

export const restBase = (host: string) => host === "github.com" ? "https://api.github.com" : `https://${host}/api/v3`

const GraphQLError = Schema.Struct({ type: Schema.optionalKey(Schema.String), message: Schema.String })

const answer = <S extends Schema.Codec<any, unknown>>(data: S) =>
  Schema.Struct({
    data: Schema.optionalKey(Schema.NullOr(data)),
    errors: Schema.optionalKey(Schema.Array(GraphQLError))
  })

const ErrorMessage = Schema.Struct({ message: Schema.String })

const header = (headers: Readonly<Record<string, string | undefined>>, name: string) => {
  const value = Number(headers[name])
  return headers[name] === undefined || !Number.isFinite(value) ? undefined : value
}

export const quotaOf = (headers: Readonly<Record<string, string | undefined>>): Option.Option<Quota> => {
  const remaining = header(headers, "x-ratelimit-remaining")
  const reset = header(headers, "x-ratelimit-reset")
  return remaining === undefined || reset === undefined ? Option.none() : Option.some({ remaining, resetAt: reset * 1000 })
}

const waitOf = (headers: Readonly<Record<string, string | undefined>>, now: number) => {
  const retryAfter = header(headers, "retry-after")
  if (retryAfter !== undefined) return Duration.seconds(retryAfter)
  const quota = quotaOf(headers)
  if (Option.isSome(quota) && quota.value.remaining === 0) return Duration.millis(Math.max(quota.value.resetAt - now, 1000))
  return Duration.minutes(1)
}

export interface Answered<A> {
  readonly data: A
  readonly quota: Option.Option<Quota>
}

/** A REST answer, or `null` data when the server answered 304 to the ETag sent. */
export interface RestAnswered<A> {
  readonly data: A | null
  readonly etag: string | null
  readonly quota: Option.Option<Quota>
}

export interface Transport {
  readonly graphql: <S extends Schema.Codec<any, unknown>>(
    connection: Connection,
    data: S,
    query: string,
    variables: Record<string, unknown>
  ) => Effect.Effect<Answered<S["Type"]>, GitHubError>
  /** A GET of `path` under the REST API root. 404 is `NotFound`; a 403 that is not a rate limit is `Forbidden`. */
  readonly rest: <S extends Schema.Codec<any, unknown>>(
    connection: Connection,
    data: S,
    path: string,
    etag: string | null
  ) => Effect.Effect<RestAnswered<S["Type"]>, GitHubError | Forbidden>
}

/** The HTTP side GitHub connectors share: authentication, token scrubbing, and status and rate limit handling. */
export const make = (client: HttpClient.HttpClient, userAgent: string): Transport => {
  const send = (connection: Connection, request: HttpClientRequest.HttpClientRequest) =>
    Effect.gen(function*() {
      const response = yield* client.execute(request.pipe(
        HttpClientRequest.bearerToken(Redacted.value(connection.token)),
        HttpClientRequest.acceptJson,
        HttpClientRequest.setHeader("user-agent", userAgent)
      )).pipe(Effect.mapError(() => new Unavailable({ reason: `Could not reach ${connection.host}` })))
      const now = yield* Clock.currentTimeMillis
      const secret = Redacted.value(connection.token)
      const scrub = (text: string) => secret === "" ? text : text.replaceAll(secret, "[token]")
      const message = response.json.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(ErrorMessage)),
        Effect.map((body) => scrub(body.message)),
        Effect.orElseSucceed(() => `HTTP ${response.status}`)
      )
      return { response, now, scrub, message }
    })

  const refused = (
    response: HttpClientResponse.HttpClientResponse,
    now: number,
    message: Effect.Effect<string>
  ): Effect.Effect<void, GitHubError> =>
    Effect.gen(function*() {
      if (response.status === 401) {
        return yield* new Unauthorized({ reason: `GitHub refused the token: ${yield* message}` })
      }
      if (response.status === 429 || (response.status === 403 && /rate limit/i.test(yield* message))) {
        return yield* new RateLimited({ retryAfter: waitOf(response.headers, now) })
      }
      if (response.status === 403) {
        return yield* new Unauthorized({ reason: `GitHub refused access: ${yield* message}` })
      }
    })

  const unreadable = () => new Unavailable({ reason: "GitHub sent an answer this connector cannot read" })

  const graphql: Transport["graphql"] = (connection, data, query, variables) =>
    Effect.gen(function*() {
      const { message, now, response, scrub } = yield* send(
        connection,
        HttpClientRequest.post(endpoint(connection.host)).pipe(HttpClientRequest.bodyJsonUnsafe({ query, variables }))
      )
      yield* refused(response, now, message)
      if (response.status !== 200) {
        return yield* new Unavailable({ reason: `GitHub answered ${response.status}: ${yield* message}` })
      }
      const body = yield* response.json.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(answer(data))),
        Effect.mapError(unreadable)
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

  const rest: Transport["rest"] = (connection, data, path, etag) =>
    Effect.gen(function*() {
      const request = HttpClientRequest.get(`${restBase(connection.host)}${path}`).pipe(
        HttpClientRequest.setHeader("x-github-api-version", "2022-11-28"),
        etag === null ? (r) => r : HttpClientRequest.setHeader("if-none-match", etag)
      )
      const { message, now, response } = yield* send(connection, request)
      const quota = quotaOf(response.headers)
      if (response.status === 304) return { data: null, etag, quota }
      if (response.status === 403 && !/rate limit/i.test(yield* message)) {
        return yield* new Forbidden({ reason: `GitHub refused access: ${yield* message}` })
      }
      yield* refused(response, now, message)
      if (response.status === 404) return yield* new NotFound({ reason: yield* message })
      if (response.status !== 200) {
        return yield* new Unavailable({ reason: `GitHub answered ${response.status}: ${yield* message}` })
      }
      const body = yield* response.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(data)), Effect.mapError(unreadable))
      return { data: body, etag: response.headers["etag"] ?? null, quota }
    })

  return { graphql, rest }
}
