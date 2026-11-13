import { DateTime, Effect, Option, Redacted, Ref, Schema, Stream } from "effect"
import { Catalogue, Connector } from "@exangelos/connector-sdk"
import type { Filters } from "./Diff.ts"
import { descriptions, type Emitted, type EventType, payloads } from "./Events.ts"
import { type Connection, GitHub } from "./GitHub.ts"
import * as Poll from "./Poll.ts"
import * as PullRequestRef from "./PullRequestRef.ts"

const declare = <K extends EventType>(type: K) =>
  Catalogue.event(type, { description: descriptions[type], payload: payloads[type] })

export const events = {
  "head.changed": declare("head.changed"),
  "base.changed": declare("base.changed"),
  "conflict.detected": declare("conflict.detected"),
  "checks.failed": declare("checks.failed"),
  "checks.passed": declare("checks.passed"),
  "review.submitted": declare("review.submitted"),
  "review.thread": declare("review.thread"),
  "comment.added": declare("comment.added"),
  "merge.ready": declare("merge.ready")
}

const Patterns = Schema.optionalKey(Schema.Array(Schema.String))

const parameters = Catalogue.parameters({
  main: "pullRequest",
  schema: Schema.Struct({
    pullRequest: Schema.String,
    ignoreChecks: Patterns,
    ignoreAuthors: Patterns,
    ignoreComments: Patterns
  })
})

type Parameters = typeof parameters.schema.Type

const compile = (patterns: ReadonlyArray<string> | undefined, field: string) =>
  Effect.forEach(patterns ?? [], (pattern) =>
    Effect.try({
      try: () => new RegExp(pattern),
      catch: () => `${field} has a pattern that is not a regular expression: ${pattern}`
    }))

const read = (p: Parameters) =>
  Effect.gen(function*() {
    const ref = PullRequestRef.parse(p.pullRequest)
    if (ref === undefined) {
      return yield* Effect.fail(`Expected a pull request as owner/repo#number, got "${p.pullRequest}"`)
    }
    const filters: Filters = {
      checks: yield* compile(p.ignoreChecks, "ignoreChecks"),
      authors: yield* compile(p.ignoreAuthors, "ignoreAuthors"),
      comments: yield* compile(p.ignoreComments, "ignoreComments")
    }
    return { ref, filters }
  })

const Host = /^[A-Za-z0-9.-]+(:[0-9]+)?$/

const toItem = (event: Emitted, cursor: string | undefined) =>
  (events[event.type] as Catalogue.EventType<typeof event.payload>).item({
    occurredAt: DateTime.makeUnsafe(event.occurredAt),
    summary: event.summary,
    payload: event.payload,
    dedupeKey: event.dedupeKey,
    ...(event.link === null ? {} : { link: event.link }),
    ...(cursor === undefined ? {} : { cursor })
  })

export const connector = Connector.make({
  events: [
    events["head.changed"],
    events["base.changed"],
    events["conflict.detected"],
    events["checks.failed"],
    events["checks.passed"],
    events["review.submitted"],
    events["review.thread"],
    events["comment.added"],
    events["merge.ready"]
  ],
  parameters,
  configuration: [
    Catalogue.secret("token", { label: "GitHub token" }),
    Catalogue.text("host", { label: "GitHub Enterprise host (empty for github.com)", required: false, secretDestination: true })
  ],
  handlers: Effect.gen(function*() {
    const github = yield* GitHub
    const configured = yield* Ref.make(Option.none<Connection>())
    return {
      configure: (values) =>
        Effect.gen(function*() {
          const host = (values.host ?? "").trim() || "github.com"
          if (!Host.test(host)) {
            return yield* new Connector.ConfigurationRejected({ reason: `Expected a host name such as github.acme.dev, got "${host}"` })
          }
          const connection: Connection = { host, token: Redacted.make(values.token ?? "") }
          yield* github.viewer(connection).pipe(
            Effect.catchTags({
              Unauthorized: ({ reason }) => Effect.fail(new Connector.ConfigurationRejected({ reason })),
              NotFound: () => Effect.void,
              RateLimited: () => Effect.void,
              Unavailable: () => Effect.void
            })
          )
          yield* Ref.set(configured, Option.some(connection))
        }),
      describe: (p) =>
        read(p).pipe(
          Effect.mapError((reason) => new Connector.ParametersInvalid({ reason })),
          Effect.map(({ ref }) => {
            const subject = PullRequestRef.format(ref)
            return { subject, label: `Pull request ${subject}`, parameters: { ...p, pullRequest: subject } }
          })
        ),
      watch: ({ cursor, parameters: p }) =>
        Stream.unwrap(Effect.gen(function*() {
          const connection = yield* Ref.get(configured).pipe(
            Effect.flatMap(Effect.fromOption),
            Effect.mapError(() => new Connector.CredentialsRejected({ reason: "The github-pr connector is not configured" }))
          )
          const { filters, ref } = yield* read(p).pipe(Effect.mapError((reason) => new Connector.SourceFailed({ reason })))
          let last = cursor
          return Poll.watch(connection, ref, filters, cursor).pipe(
            Stream.mapError((error) => {
              switch (error._tag) {
                case "Unauthorized":
                  return new Connector.CredentialsRejected({ reason: error.reason })
                case "NotFound":
                  return new Connector.SourceFailed({
                    reason: `${PullRequestRef.format(ref)} does not exist, or the token cannot see it`
                  })
                case "Unavailable":
                  return new Connector.SourceFailed({ reason: error.reason })
              }
            }),
            Stream.flatMap((polled) => {
              const moved = polled.cursor !== last
              last = polled.cursor
              const items = polled.events.map((event, i) =>
                toItem(event, i === polled.events.length - 1 ? polled.cursor : undefined)
              )
              if (items.length === 0 && moved) items.push(Connector.cursor(polled.cursor))
              if (polled.end !== null) items.push(Connector.end(`The pull request was ${polled.end}`))
              return Stream.fromIterable(items)
            })
          )
        }))
    }
  })
})
