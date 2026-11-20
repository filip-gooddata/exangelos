import { Clock, DateTime, Duration, Effect, Option, Ref, Schema, Stream } from "effect"
import { Catalogue, Connector } from "@exangelos/connector-sdk"
import { EventPayload, reconcile, type EventType } from "./Reconcile.ts"
import { localSource, type Source } from "./Source.ts"

const declare = (type: EventType) => Catalogue.event(type, {
  description: "A change between delayed persisted Slack snapshots; intermediate changes may be missed",
  payload: Schema.Union([EventPayload, Schema.Struct({ count: Schema.Literal(1) })])
})
const events = {
  "message.new": declare("message.new"), "thread.reply": declare("thread.reply"),
  "message.edited": declare("message.edited"), "reaction.added": declare("reaction.added"),
  "reaction.removed": declare("reaction.removed")
}
const reason = "Slack private configuration or persisted snapshot is unavailable or inconsistent"
const authorize = "Configure Slack with exangelos connector configure slack subscriptionAccess=persisted-cache, then subscribe with a conversation ID or message reference"
const retired = "This Slack selection is retired. Configure subscriptionAccess=persisted-cache and create a new subscription with a conversation ID or message reference"
const pin = /^scope-[a-f0-9]{64}$/
interface Configuration {
  readonly cacheRoot?: string
  readonly interval: Duration.Duration
}
export const make = <R>(source: Source<R>) => Connector.make({
  events: [events["message.new"], events["thread.reply"], events["message.edited"], events["reaction.added"], events["reaction.removed"]],
  parameters: Catalogue.parameters({ main: "selection", schema: Schema.Struct({
    selection: Schema.String.annotate({ message: "Supply a Slack conversation ID or message reference as a string" }),
    scope: Schema.optionalKey(Schema.String.annotate({ message: "Use scope=conversation or scope=replies" }))
  }) }),
  configuration: [
    Catalogue.choice("subscriptionAccess", { label: "Allow reading persisted Slack cache data and sharing conversation labels, message timestamps, links and available senders with the host, even after logout or access changes (sign-in unverified)", choices: ["persisted-cache", "disabled"], required: false }),
    Catalogue.text("cacheRoot", { label: "Optional absolute IndexedDB folder for a custom Slack installation", required: false }),
    Catalogue.text("subscriptionCacheRoot", { label: "Optional subscription cache folder override (takes precedence over cacheRoot)", required: false }),
    Catalogue.text("pollIntervalMs", { label: "Poll interval in milliseconds (staleness is unbounded)", required: false })
  ],
  handlers: Effect.gen(function*() {
    const configured = yield* Ref.make<Configuration | undefined>(undefined)
    const resolve = (configuration: Configuration, subject: string, scope?: string) => Effect.gen(function*() {
      if (subject === "selected") return yield* new Connector.ParametersInvalid({ reason: retired })
      if (scope !== undefined && (pin.test(subject) || (scope !== "conversation" && scope !== "replies"))) {
        return yield* new Connector.ParametersInvalid({ reason: "Use scope=conversation or scope=replies with a Slack message reference" })
      }
      if (!subject.length || subject.length > 2048) {
        return yield* new Connector.ParametersInvalid({ reason: "Use a Slack conversation ID or message reference" })
      }
      const { label, ...request } = yield* source.setup({
        subscriptionAccess: "persisted-cache", subject,
        ...(scope !== undefined && { scope }), ...(configuration.cacheRoot && { cacheRoot: configuration.cacheRoot })
      }).pipe(Effect.mapError((error) => new Connector.ParametersInvalid({ reason: error.reason })))
      if (pin.test(subject) && subject !== `scope-${request.expectedScope}`) {
        return yield* new Connector.ParametersInvalid({ reason: retired })
      }
      if ((yield* Ref.get(configured)) !== configuration) return yield* new Connector.ParametersInvalid({ reason: authorize })
      return { request, label }
    })
    return {
      configure: (values) => Effect.gen(function*() {
        yield* Ref.set(configured, undefined)
        if (values.subscriptionAccess === "disabled") return
        if (values.subscriptionAccess !== "persisted-cache") return yield* new Connector.ConfigurationRejected({ reason: authorize })
        const text = values.pollIntervalMs ?? "30000"
        const interval = Number(text)
        if (!/^[0-9]+$/.test(text) || !Number.isSafeInteger(interval) || interval < 1000 || interval > 3600000) {
          return yield* new Connector.ConfigurationRejected({ reason: "pollIntervalMs must be an integer from 1000 to 3600000" })
        }
        const cacheRoot = values.subscriptionCacheRoot || values.cacheRoot
        yield* Ref.set(configured, { interval: Duration.millis(interval), ...(cacheRoot && { cacheRoot }) })
      }),
      describe: ({ selection, scope }) => Effect.gen(function*() {
        const configuration = yield* Ref.get(configured)
        if (!configuration) return yield* new Connector.ParametersInvalid({ reason: authorize })
        const { request, label } = yield* resolve(configuration, selection, scope)
        return { subject: `slack:${request.expectedScope}`, label, parameters: { selection: `scope-${request.expectedScope}` } }
      }),
      watch: ({ parameters, cursor }) => Stream.unwrap(Effect.gen(function*() {
        const configuration = yield* Ref.get(configured)
        if (!configuration) return yield* new Connector.SourceFailed({ reason: authorize })
        if (!pin.test(parameters.selection) || parameters.scope !== undefined) return yield* new Connector.SourceFailed({ reason: retired })
        const { request } = yield* resolve(configuration, parameters.selection).pipe(
          Effect.mapError((error) => new Connector.SourceFailed({ reason: error.reason }))
        )
        return Stream.paginate({ cursor, first: true }, (state) => Effect.gen(function*() {
          if (!state.first) yield* Effect.sleep(configuration.interval)
          if ((yield* Ref.get(configured)) !== configuration) return yield* new Connector.SourceFailed({ reason })
          const startedAt = state.cursor === undefined ? yield* Clock.currentTimeMillis : undefined
          const snapshot = yield* source.read(request)
          if (snapshot.scope !== request.expectedScope || (yield* Ref.get(configured)) !== configuration) {
            return yield* new Connector.SourceFailed({ reason })
          }
          const result = yield* reconcile(state.cursor, snapshot, startedAt)
          if ((yield* Ref.get(configured)) !== configuration) return yield* new Connector.SourceFailed({ reason: authorize })
          const items = result.events.map((event, index) => events[event.type].item({
            occurredAt: DateTime.makeUnsafe(event.occurredAt), summary: "Selected Slack conversation changed in a persisted snapshot",
            payload: event.payload ?? { count: 1 }, dedupeKey: event.dedupeKey,
            ...(index === result.events.length - 1 ? { cursor: result.cursor } : {})
          }))
          if (items.length === 0 && state.cursor !== result.cursor) items.push(Connector.cursor(result.cursor))
          return [items, Option.some({ cursor: result.cursor as string | undefined, first: false })] as const
        }).pipe(
          Effect.catchTag("LegacyCursor", () => Effect.succeed([[Connector.end(
            "This Slack cursor predates message freshness tracking. Create a new subscription for the same selection to establish a baseline."
          )], Option.none()] as const)),
          Effect.mapError(() => new Connector.SourceFailed({ reason }))
        ))
      }))
    }
  })
})
export const connector = make(localSource)
