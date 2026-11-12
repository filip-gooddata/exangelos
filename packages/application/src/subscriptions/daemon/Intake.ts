import { Array as Arr, DateTime, Effect, Layer, Option, Result } from "effect"
import { Intake, Lifecycle } from "@exangelos/domain"
import type { Event, Ids, Subscription } from "@exangelos/domain"
import * as NewId from "../../NewId.ts"
import { EventRepository } from "../../ports/EventRepository.ts"
import { PluginRepository } from "../../ports/PluginRepository.ts"
import { SubscriptionRepository } from "../../ports/SubscriptionRepository.ts"
import { WakeRepository } from "../../ports/WakeRepository.ts"
import { SubscriptionIntake, type Verdict } from "../../seam/SubscriptionIntake.ts"
import { currentLimits } from "../Limits.ts"
import { SubscriptionSignals } from "../Signals.ts"
import { commit, type CommitServices } from "../Transitions.ts"
import { requestWake } from "../Wakes.ts"

export type IntakeServices = CommitServices | PluginRepository

const verdictOf = (subscription: Subscription.Subscription): Verdict =>
  subscription.state._tag === "Active" ? "continue" : "stop"

/** The receive time of the oldest event the session has not acknowledged. */
export const oldestPending = (subscription: Subscription.Subscription) =>
  Effect.gen(function*() {
    const events = yield* EventRepository
    const pending = yield* events.list(subscription.id, subscription.ackedThrough)
    return Option.map(Arr.head(pending), (event) => event.receivedAt)
  })

const admitEvent = (
  before: Subscription.Subscription,
  reported: Event.ReportedEvent,
  cursor: Option.Option<string>
) =>
  Effect.gen(function*() {
    const events = yield* EventRepository
    const duplicate = Option.isSome(yield* events.findByDedupeKey(before.id, reported.dedupeKey))
    const id = yield* NewId.eventId
    const now = yield* DateTime.now
    const admission = Intake.admit({ subscription: before, reported, cursor, duplicate, id, now })
    if (Option.isNone(admission.event)) {
      if (admission.subscription !== before) yield* commit(Option.some(before), { ...admission, wake: Option.none() })
      return admission.subscription
    }
    const event = admission.event.value
    const limits = yield* currentLimits
    const oldest = Option.orElse(yield* oldestPending(before), () => Option.some(event.receivedAt))
    const step = Option.getOrElse(
      Lifecycle.backlog(admission.subscription, oldest, now, limits),
      () => admission
    )
    yield* commit(Option.some(before), { subscription: step.subscription, wake: step.wake, events: [event] })
    return step.subscription
  })

const ingest = (id: Ids.SubscriptionId, item: Event.WatchItem) =>
  Effect.gen(function*() {
    const subscriptions = yield* SubscriptionRepository
    const found = yield* subscriptions.find(id)
    if (Option.isNone(found) || found.value.state._tag !== "Active") return "stop" as const
    const before = found.value
    switch (item._tag) {
      case "Event":
        return verdictOf(yield* admitEvent(before, item.event, Option.fromUndefinedOr(item.cursor)))
      case "Cursor": {
        const subscription = { ...before, cursor: item.cursor }
        yield* commit(found, { subscription, wake: Option.none() })
        return verdictOf(subscription)
      }
      case "End": {
        const now = yield* DateTime.now
        const ended = Lifecycle.end(before, { _tag: "Plugin", reason: item.reason }, now)
        if (Result.isFailure(ended)) return "stop" as const
        yield* commit(found, ended.success)
        return verdictOf(ended.success.subscription)
      }
    }
  })

const lastSuspensionWake = (subscription: Ids.SubscriptionId) =>
  Effect.gen(function*() {
    const wakes = yield* WakeRepository
    const all = yield* wakes.list(subscription)
    return Option.map(
      Arr.findLast(all, (wake) => wake.reason === "suspended"),
      (wake) => wake.createdAt
    )
  })

const suspended = (plugin: Ids.PluginName, since: DateTime.Utc) =>
  Effect.gen(function*() {
    const plugins = yield* PluginRepository
    const found = yield* plugins.find(plugin)
    if (Option.isNone(found)) return
    const record = { ...found.value, unavailableSince: since }
    const limits = yield* currentLimits
    const now = yield* DateTime.now
    const subscriptions = yield* SubscriptionRepository
    const signals = yield* SubscriptionSignals
    for (const subscription of yield* subscriptions.list({ plugin, states: ["Active"] })) {
      const last = yield* lastSuspensionWake(subscription.id)
      const why = Lifecycle.suspensionWake(subscription, record, last, now, limits)
      if (Option.isNone(why)) continue
      yield* requestWake(subscription, why.value)
      yield* signals.changed(subscription.id)
    }
  })

const restored = (plugin: Ids.PluginName) =>
  Effect.gen(function*() {
    const subscriptions = yield* SubscriptionRepository
    const wakes = yield* WakeRepository
    for (const subscription of yield* subscriptions.list({ plugin })) {
      const undelivered = yield* wakes.findUndelivered(subscription.id)
      if (Option.isSome(undelivered) && undelivered.value.reason === "suspended") {
        yield* wakes.update({ ...undelivered.value, state: "dropped" })
      }
    }
  })

/** The subscription half's intake, as the plugin half's Watch streams and supervision call it. */
export const layerSubscriptionIntake: Layer.Layer<SubscriptionIntake, never, IntakeServices> = Layer.effect(
  SubscriptionIntake,
  Effect.gen(function*() {
    const context = yield* Effect.context<IntakeServices>()
    return {
      ingest: (id, item) => Effect.provideContext(ingest(id, item), context),
      suspended: (plugin, since) => Effect.provideContext(suspended(plugin, since), context),
      restored: (plugin) => Effect.provideContext(restored(plugin), context)
    }
  })
)
