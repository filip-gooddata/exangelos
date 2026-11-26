import { Clock, Deferred, DateTime, Duration, Effect, Option, Ref, Schema, Stream } from "effect"
import { localAppIcon } from "../../shared/localAppIcon.ts"
import { Catalogue, Connector } from "@exangelos/connector-sdk"
import { observationBudget, observedMillis, resumeWaiting, waitingCursor } from "../../shared/pendingSubject.ts"
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
const reason = "Could not read Slack. Check the selected desktop profile and try again."
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
    Catalogue.choice("notificationLog", { label: "Read new Slack Desktop notification records from the selected profile to detect arrivals and check the selected cache for complete details", choices: ["disabled", "enabled"], required: false }),
    Catalogue.choice("messagePreviews", { label: "Share short visible excerpts, including filenames, which may contain confidential text, from selected messages in new message, reply and edit events, including wakes, stored event history, desktop alerts and debug payload logs", choices: ["disabled", "enabled"], required: false }),
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
      icon: Effect.promise((signal) => localAppIcon(["com.tinyspeck.slackmacgap"], Connector.maxIconBytes, signal)),
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
      watch: ({ parameters, cursor, eventTypes, createdAt }) => Stream.unwrap(Effect.gen(function*() {
        const configuration = yield* Ref.get(configured)
        if (!configuration) return yield* new Connector.SourceFailed({ reason: authorize })
        if (!pin.test(parameters.selection) || parameters.scope !== undefined) return yield* new Connector.SourceFailed({ reason: retired })
        const { request, label } = yield* resolve(configuration, parameters.selection, undefined, true).pipe(
          Effect.mapError((error) => new Connector.SourceFailed({ reason: error.reason, category: error._tag === "SourceUnavailable" ? error.category ?? "unavailable" : "scope-changed" }))
        )
        const active = Effect.gen(function*() {
          if ((yield* Ref.get(configured)) !== configuration) return yield* new Connector.SourceFailed({ reason: authorize })
        })
        const waiting = resumeWaiting(request.expectedScope, cursor)
        if (cursor?.startsWith("waiting:") && !waiting) return yield* new Connector.SourceFailed({ reason: "This watch belongs to a different Slack selection or cannot be resumed" })
        const startedAt = createdAt ? DateTime.toEpochMillis(createdAt) : yield* Clock.currentTimeMillis
        const read = Effect.gen(function*() {
          yield* active
          const snapshot = yield* source.read(configuration.includePreview ? { ...request, includePreview: true } : request)
          if (snapshot.scope !== request.expectedScope) return yield* new Connector.SourceFailed({ reason, category: "scope-changed" })
          return snapshot
        })
        const progress = yield* Ref.make({ cursor: waiting?.ledger ?? cursor, first: true, acquiring: !!waiting || cursor === undefined,
          elapsed: waiting?.elapsed ?? 0, lastRead: undefined as number | undefined })
        const tick = { kind: "cache" } as const
        const cache = Stream.make(tick).pipe(Stream.concat(
          Stream.fromEffectRepeat(Effect.suspend(() => Ref.get(progress).pipe(Effect.flatMap((state) => Effect.sleep(state.acquiring ? Duration.min(configuration.interval, Duration.seconds(30)) : configuration.interval)), Effect.as(tick))))
        ))
        const selectedTypes: ReadonlyArray<string> = eventTypes
        const accepts = (type: string) => !selectedTypes.length || selectedTypes.includes(type)
        const arrivals = ["message.new", "thread.reply"].filter(accepts)
        const useLog = configuration.notificationLog && (accepts("thread.reply") || (!request.selection.thread && accepts("message.new")))
        const emptyCheckpoint = reconcile(undefined, {
          scope: request.expectedScope, complete: true, generation: "0", snapshot: "0".repeat(64), messages: []
        }, startedAt)
        if (useLog && cursor === undefined) {
          // The daemon reopens a finished Watch with its durably ingested cursor.
          const checkpoint = yield* emptyCheckpoint.pipe(Effect.mapError(() => new Connector.SourceFailed({ reason, category: "invalid-data" })))
          return Stream.make(Connector.cursor(waitingCursor(request.expectedScope, 0, checkpoint.cursor)))
        }
        const updates = useLog ? Stream.merge(cache, notifications(request, label).pipe(
          Stream.filter((notification) => accepts(notification.reply ? "thread.reply" : "message.new")),
          Stream.map((notification) => ({ kind: "notice", notification } as const))
        ), { haltStrategy: "left" }) : cache
        return updates.pipe(Stream.flatMap((update) => Stream.paginate(false, (refresh) => Effect.gen(function*() {
          const state = yield* Ref.get(progress)
          yield* active
          if (state.acquiring && update.kind === "notice") return [[], Option.none()] as const
          const snapshot = refresh || update.kind === "cache" ? yield* read : undefined
          if (snapshot?.threadMismatch) return [[Connector.end("This message belongs to a different Slack thread. Please check the thread link.")], Option.none()] as const
          const now = yield* Clock.currentTimeMillis
          let input = state.cursor
          if (!input && (snapshot?.missing || createdAt)) input = (yield* emptyCheckpoint).cursor
          const result = snapshot ? yield* reconcile(input, snapshot, startedAt, undefined, configuration.includePreview, arrivals)
            : yield* reconcile(input, { scope: request.expectedScope }, undefined, update.kind === "notice" ? update.notification : undefined, configuration.includePreview)
          if (state.acquiring && snapshot?.missing && !result.replayedVisible) {
            yield* active
            const elapsed = observedMillis(state.elapsed, state.lastRead, now, Math.min(Duration.toMillis(configuration.interval), 30000))
            const subject = request.selection.thread ? "thread" : "conversation"
            if (elapsed >= observationBudget) return [[Connector.end(`Couldn't find this ${subject}. Please check the ${subject} ID or link.`)], Option.none()] as const
            const next = waitingCursor(request.expectedScope, elapsed, result.cursor)
            yield* Ref.set(progress, { cursor: result.cursor, first: false, acquiring: true, elapsed, lastRead: now })
            return [[Connector.pending(`Waiting for this ${subject} to appear.`, next)], Option.none()] as const
          }
          yield* active
          const items = result.events.map((event, index) => events[event.type].item({
            occurredAt: DateTime.makeUnsafe(event.occurredAt), summary: event.summary ?? "Selected Slack conversation changed in a persisted snapshot",
            payload: event.payload ?? { count: 1 }, dedupeKey: event.dedupeKey,
            ...(index === result.events.length - 1 ? { cursor: result.cursor } : {})
          }))
          if (!state.cursor && input && items.length) items.unshift(Connector.cursor(input))
          if (items.length === 0 && (state.acquiring || state.first || state.cursor !== result.cursor)) items.push(Connector.cursor(result.cursor))
          yield* Ref.set(progress, { ...state, cursor: result.cursor, first: false, acquiring: false })
          return [items, result.refreshCache || result.retryObservation ? Option.some(refresh || !!result.refreshCache) : Option.none()] as const
        }))),
          Stream.interruptWhen(Deferred.await(configuration.revoked).pipe(Effect.andThen(Effect.fail(new Connector.SourceFailed({ reason: authorize }))))),
          Stream.catchTag("LegacyCursor", () => Stream.make(Connector.end(
            "This Slack watch uses an older format. Create a new subscription with the original ID or link."
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
