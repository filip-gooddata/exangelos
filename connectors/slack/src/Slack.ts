import { Clock, Deferred, DateTime, Duration, Effect, Option, Ref, Schema, Stream } from "effect"
import { localAppIcon } from "../../shared/localAppIcon.ts"
import { Catalogue, Connector } from "@exangelos/connector-sdk"
import { EventPayload, reconcile, type EventType } from "./Reconcile.ts"
import { localSource, notifications, type Source } from "./Source.ts"

const declare = (type: EventType) => Catalogue.event(type, {
  description: "A selected Slack change observed locally; intermediate changes may be missed",
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
  readonly revoked: Deferred.Deferred<void>
  readonly notificationLog: boolean
  readonly includePreview: boolean
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
    Catalogue.choice("notificationLog", { label: "Read new Slack Desktop notification records from the selected profile for early message timestamps and links", choices: ["disabled", "enabled"], required: false }),
    Catalogue.choice("messagePreviews", { label: "Share short visible excerpts, which may contain confidential text, from selected messages in new message, reply and edit events, including wakes, stored event history, desktop alerts and debug payload logs", choices: ["disabled", "enabled"], required: false }),
    Catalogue.text("cacheRoot", { label: "Optional absolute IndexedDB folder for a custom Slack installation", required: false }),
    Catalogue.text("subscriptionCacheRoot", { label: "Optional subscription cache folder override (takes precedence over cacheRoot)", required: false }),
    Catalogue.text("pollIntervalMs", { label: "Poll interval in milliseconds (staleness is unbounded)", required: false })
  ],
  handlers: Effect.gen(function*() {
    const configured = yield* Ref.make<Configuration | undefined>(undefined)
    const resolve = (configuration: Configuration, subject: string, scope?: string, pinOnly = false) => Effect.gen(function*() {
      if (subject === "selected") return yield* new Connector.ParametersInvalid({ reason: retired })
      if (scope !== undefined && (pin.test(subject) || (scope !== "conversation" && scope !== "replies"))) {
        return yield* new Connector.ParametersInvalid({ reason: "Use scope=conversation or scope=replies with a Slack message reference" })
      }
      if (!subject.length || subject.length > 2048) {
        return yield* new Connector.ParametersInvalid({ reason: "Use a Slack conversation ID or message reference" })
      }
      const { label, ...request } = yield* source.setup({
        subscriptionAccess: "persisted-cache", subject, ...(pinOnly && { pinOnly: "true" }),
        ...(scope !== undefined && { scope }), ...(configuration.cacheRoot && { cacheRoot: configuration.cacheRoot })
      })
      if (pin.test(subject) && subject !== `scope-${request.expectedScope}`) {
        return yield* new Connector.ParametersInvalid({ reason: retired })
      }
      if ((yield* Ref.get(configured)) !== configuration) return yield* new Connector.ParametersInvalid({ reason: authorize })
      return { request, label }
    })
    return {
      icon: Effect.promise(() => localAppIcon(["com.tinyspeck.slackmacgap"], Connector.maxIconBytes)),
      configure: (values) => Effect.gen(function*() {
        const previous = yield* Ref.getAndSet(configured, undefined)
        if (previous) yield* Deferred.succeed(previous.revoked, undefined)
        if (values.subscriptionAccess === "disabled") return
        if (values.subscriptionAccess !== "persisted-cache") return yield* new Connector.ConfigurationRejected({ reason: authorize })
        const text = values.pollIntervalMs ?? "30000"
        const interval = Number(text)
        if (!/^[0-9]+$/.test(text) || !Number.isSafeInteger(interval) || interval < 1000 || interval > 3600000) {
          return yield* new Connector.ConfigurationRejected({ reason: "pollIntervalMs must be an integer from 1000 to 3600000" })
        }
        if (values.messagePreviews !== undefined && !["disabled", "enabled"].includes(values.messagePreviews)) {
          return yield* new Connector.ConfigurationRejected({ reason: "messagePreviews must be enabled or disabled" })
        }
        if (values.notificationLog !== undefined && !["enabled", "disabled"].includes(values.notificationLog)) {
          return yield* new Connector.ConfigurationRejected({ reason: "notificationLog must be enabled or disabled" })
        }
        const cacheRoot = values.subscriptionCacheRoot || values.cacheRoot
        yield* Ref.set(configured, { revoked: yield* Deferred.make<void>(), notificationLog: values.notificationLog === "enabled", includePreview: values.messagePreviews === "enabled", interval: Duration.millis(interval), ...(cacheRoot && { cacheRoot }) })
      }),
      describe: ({ selection, scope }) => Effect.gen(function*() {
        const configuration = yield* Ref.get(configured)
        if (!configuration) return yield* new Connector.ParametersInvalid({ reason: authorize })
        const { request, label } = yield* resolve(configuration, selection, scope).pipe(
          Effect.mapError((error) => new Connector.ParametersInvalid({ reason: error.reason }))
        )
        return { subject: `slack:${request.expectedScope}`, label, parameters: { selection: `scope-${request.expectedScope}` } }
      }),
      watch: ({ parameters, cursor, eventTypes }) => Stream.unwrap(Effect.gen(function*() {
        const configuration = yield* Ref.get(configured)
        if (!configuration) return yield* new Connector.SourceFailed({ reason: authorize })
        if (!pin.test(parameters.selection) || parameters.scope !== undefined) return yield* new Connector.SourceFailed({ reason: retired })
        const { request, label } = yield* resolve(configuration, parameters.selection, undefined, configuration.notificationLog).pipe(
          Effect.mapError((error) => new Connector.SourceFailed({ reason: error.reason, category: error._tag === "SourceUnavailable" ? error.category ?? "unavailable" : "scope-changed" }))
        )
        const active = Effect.gen(function*() {
          if ((yield* Ref.get(configured)) !== configuration) return yield* new Connector.SourceFailed({ reason: authorize })
        })
        const startedAt = cursor === undefined ? yield* Clock.currentTimeMillis : undefined
        const read = Effect.gen(function*() {
          yield* active
          const snapshot = yield* source.read(configuration.includePreview ? { ...request, includePreview: true } : request)
          if (snapshot.scope !== request.expectedScope) return yield* new Connector.SourceFailed({ reason, category: "scope-changed" })
          return { kind: "cache", snapshot } as const
        })
        const cache = Stream.fromEffect(read).pipe(Stream.concat(
          Stream.fromEffectRepeat(Effect.sleep(configuration.interval).pipe(Effect.andThen(read)))
        ))
        const selectedTypes: ReadonlyArray<string> = eventTypes
        const accepts = (type: string) => !selectedTypes.length || selectedTypes.includes(type)
        const useLog = configuration.notificationLog && (accepts("thread.reply") || (!request.selection.thread && accepts("message.new")))
        const initialCursor = useLog && cursor === undefined ? (yield* reconcile(undefined, {
          scope: request.expectedScope, complete: true, generation: "0", snapshot: "0".repeat(64), messages: []
        }, startedAt).pipe(Effect.mapError(() => new Connector.SourceFailed({ reason, category: "invalid-data" })))).cursor : cursor
        const updates = useLog ? Stream.merge(cache, notifications(request, label).pipe(
          Stream.filter((notification) => accepts(notification.reply ? "thread.reply" : "message.new")),
          Stream.map((notification) => ({ kind: "notice", notification } as const))
        ), { haltStrategy: "left" }) : cache
        const progress = yield* Ref.make({ cursor: initialCursor, first: true })
        return updates.pipe(Stream.flatMap((update) => Stream.paginate(undefined, () => Effect.gen(function*() {
          const state = yield* Ref.get(progress)
          yield* active
          const result = update.kind === "cache" ? yield* reconcile(state.cursor, update.snapshot, startedAt)
            : yield* reconcile(state.cursor, { scope: request.expectedScope }, undefined, update.notification)
          yield* active
          const items = result.events.map((event, index) => events[event.type].item({
            occurredAt: DateTime.makeUnsafe(event.occurredAt), summary: event.summary ?? "Selected Slack conversation changed in a persisted snapshot",
            payload: event.payload ?? { count: 1 }, dedupeKey: event.dedupeKey,
            ...(index === result.events.length - 1 ? { cursor: result.cursor } : {})
          }))
          if (items.length === 0 && (state.first || state.cursor !== result.cursor)) items.push(Connector.cursor(result.cursor))
          yield* Ref.set(progress, { cursor: result.cursor, first: false })
          return [items, result.retryObservation ? Option.some(undefined) : Option.none()] as const
        }))),
          Stream.interruptWhen(Deferred.await(configuration.revoked)),
          Stream.catchTag("LegacyCursor", () => Stream.make(Connector.end(
            "This Slack cursor predates message freshness tracking. Create a new subscription for the same selection to establish a baseline."
          ))),
          Stream.mapError((error) => error._tag === "SourceFailed" ? error : new Connector.SourceFailed({
            reason, category: error._tag === "SourceUnavailable" ? error.category ?? "unavailable" : "invalid-data"
          }))
        )
      }))
    }
  })
})
export const connector = make(localSource)
