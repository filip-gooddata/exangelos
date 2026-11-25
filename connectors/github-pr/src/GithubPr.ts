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
  "draft.changed": declare("draft.changed"),
  "base.changed": declare("base.changed"),
  "conflict.detected": declare("conflict.detected"),
  "checks.failed": declare("checks.failed"),
  "checks.passed": declare("checks.passed"),
  "check.passed": declare("check.passed"),
  "review.submitted": declare("review.submitted"),
  "review.thread": declare("review.thread"),
  "review.reply": declare("review.reply"),
  "comment.added": declare("comment.added"),
  "merge.ready": declare("merge.ready"),
  "reviewer.submitted": declare("reviewer.submitted"),
  "review.rerequested": declare("review.rerequested"),
  "author.activity": declare("author.activity")
}

/** A list, or from the command line one value or a JSON array in a string. */
const List = (description: string) =>
  Schema.optionalKey(Schema.Union([Schema.Array(Schema.String), Schema.String]).annotate({ description }))

const parameters = Catalogue.parameters({
  main: "pullRequest",
  schema: Schema.Struct({
    pullRequest: Schema.String,
    ignoreChecks: List("Regular expressions for check names that never notify"),
    ignoreAuthors: List("Regular expressions for author logins that never notify"),
    ignoreComments: List("Regular expressions for comment bodies that never notify"),
    ignoreIds: List("Node ids, URLs or URL fragments of threads, comments or reviews that never notify"),
    wakeOnCheckPass: List("Regular expressions for check names that report check.passed once per head"),
    readyWait: List("Regular expressions for check names that merge.ready also waits for"),
    reviewStates: List("Review states review.submitted reports: APPROVED, CHANGES_REQUESTED, COMMENTED, DISMISSED"),
    reviewer: Schema.optionalKey(
      Schema.String.annotate({ description: "A login; enables reviewer.submitted, review.rerequested and author.activity" })
    ),
    baseHead: Schema.optionalKey(
      Schema.String.annotate({ description: "A base commit SHA, or current; base.changed then reports a base that differs" })
    ),
    reportExistingThreads: Schema.optionalKey(
      Schema.Union([Schema.Boolean, Schema.Literals(["true", "false"])]).annotate({
        description: "Report the unresolved threads on the first poll"
      })
    )
  })
})

type Parameters = typeof parameters.schema.Type

const list = (value: ReadonlyArray<string> | string | undefined, field: string) => {
  if (value === undefined) return Effect.succeed<ReadonlyArray<string>>([])
  if (typeof value !== "string") return Effect.succeed(value)
  return Effect.succeed(jsonList(value) ?? [value])
}

/** A JSON array of strings, or undefined for anything else, such as a regular expression that starts with `[`. */
const jsonList = (value: string): ReadonlyArray<string> | undefined => {
  if (!value.trim().startsWith("[")) return undefined
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string") ? parsed : undefined
  } catch {
    return undefined
  }
}

const ReviewStates = ["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED"]
const Login = /^[A-Za-z0-9][A-Za-z0-9-]*(\[bot\])?$/
const Sha = /^[0-9a-f]{7,40}$/

const compile = (value: ReadonlyArray<string> | string | undefined, field: string) =>
  Effect.flatMap(list(value, field), (patterns) => Effect.forEach(patterns, (pattern) =>
    Effect.try({
      try: () => new RegExp(pattern),
      catch: () => `${field} has a pattern that is not a regular expression: ${pattern}`
    })))

const read = (p: Parameters) =>
  Effect.gen(function*() {
    const ref = PullRequestRef.parse(p.pullRequest)
    if (ref === undefined) {
      return yield* Effect.fail(`Expected a pull request as owner/repo#number, got "${p.pullRequest}"`)
    }
    const reviewStates = p.reviewStates === undefined
      ? null
      : (yield* list(p.reviewStates, "reviewStates")).map((state) => state.trim().toUpperCase())
    const unknownState = reviewStates?.find((state) => !ReviewStates.includes(state))
    if (unknownState !== undefined) {
      return yield* Effect.fail(`reviewStates has "${unknownState}"; expected some of ${ReviewStates.join(", ")}`)
    }
    const reviewer = p.reviewer?.trim() || null
    if (reviewer !== null && !Login.test(reviewer)) {
      return yield* Effect.fail(`Expected reviewer to be a GitHub login, got "${p.reviewer}"`)
    }
    const baseHead = p.baseHead?.trim().toLowerCase() || null
    if (baseHead !== null && baseHead !== "current" && !Sha.test(baseHead)) {
      return yield* Effect.fail(`Expected baseHead to be a commit SHA or current, got "${p.baseHead}"`)
    }
    const filters: Filters = {
      checks: yield* compile(p.ignoreChecks, "ignoreChecks"),
      authors: yield* compile(p.ignoreAuthors, "ignoreAuthors"),
      comments: yield* compile(p.ignoreComments, "ignoreComments"),
      ignoreIds: (yield* list(p.ignoreIds, "ignoreIds")).map((id) => id.trim()).filter((id) => id.length > 0),
      checkPass: yield* compile(p.wakeOnCheckPass, "wakeOnCheckPass"),
      readyWait: yield* compile(p.readyWait, "readyWait"),
      reviewStates,
      reviewer,
      baseHead,
      existingThreads: p.reportExistingThreads === true || p.reportExistingThreads === "true"
    }
    const normalised: Parameters = {
      ...p,
      ...(p.ignoreChecks === undefined ? {} : { ignoreChecks: yield* list(p.ignoreChecks, "ignoreChecks") }),
      ...(p.ignoreAuthors === undefined ? {} : { ignoreAuthors: yield* list(p.ignoreAuthors, "ignoreAuthors") }),
      ...(p.ignoreComments === undefined ? {} : { ignoreComments: yield* list(p.ignoreComments, "ignoreComments") }),
      ...(p.ignoreIds === undefined ? {} : { ignoreIds: filters.ignoreIds }),
      ...(p.wakeOnCheckPass === undefined ? {} : { wakeOnCheckPass: yield* list(p.wakeOnCheckPass, "wakeOnCheckPass") }),
      ...(p.readyWait === undefined ? {} : { readyWait: yield* list(p.readyWait, "readyWait") }),
      ...(reviewStates === null ? {} : { reviewStates }),
      ...(reviewer === null ? {} : { reviewer }),
      ...(baseHead === null ? {} : { baseHead }),
      ...(p.reportExistingThreads === undefined ? {} : { reportExistingThreads: filters.existingThreads })
    }
    return { ref, filters, normalised }
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
    events["draft.changed"],
    events["base.changed"],
    events["conflict.detected"],
    events["checks.failed"],
    events["checks.passed"],
    events["check.passed"],
    events["review.submitted"],
    events["review.thread"],
    events["review.reply"],
    events["comment.added"],
    events["merge.ready"],
    events["reviewer.submitted"],
    events["review.rerequested"],
    events["author.activity"]
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
          Effect.map(({ normalised, ref }) => {
            const subject = PullRequestRef.format(ref)
            return { subject, label: `Pull request ${subject}`, parameters: { ...normalised, pullRequest: subject } }
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
          let first = true
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
              const moved = polled.cursor !== last || first
              last = polled.cursor
              first = false
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
