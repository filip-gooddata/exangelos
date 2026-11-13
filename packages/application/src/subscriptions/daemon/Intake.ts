import { Array as Arr, DateTime, Effect, Layer, Option, Result } from "effect"
import { Alert, Delivery, Intake, Lifecycle, PluginRules, Settings } from "@exangelos/domain"
import type { Event, Ids, Plugin, Subscription, Wake } from "@exangelos/domain"
import * as NewId from "../../NewId.ts"
import { AlertSink } from "../../ports/AlertSink.ts"
import { EventRepository } from "../../ports/EventRepository.ts"
import { SettingsStore } from "../../ports/SettingsStore.ts"
import { SubscriptionRepository } from "../../ports/SubscriptionRepository.ts"
import { WakeRepository } from "../../ports/WakeRepository.ts"
import { SubscriptionIntake, type Verdict } from "../../seam/SubscriptionIntake.ts"
import { currentLimits } from "../Limits.ts"
import { SubscriptionLocks } from "../Locks.ts"
import { SubscriptionSignals } from "../Signals.ts"
import { commit, type CommitServices } from "../Transitions.ts"
import { requestWake } from "../Wakes.ts"
import { RemovedPlugins, type Unavailable } from "../RemovedPlugins.ts"

export type IntakeServices = CommitServices | SubscriptionLocks | RemovedPlugins | AlertSink

/** Runs one subscription's load-change-store under its lock, with the subscription as stored now. */
export const withSubscription = <A, R>(
  id: Ids.SubscriptionId,
  work: (subscription: Subscription.Subscription) => Effect.Effect<A, never, R>
): Effect.Effect<Option.Option<A>, never, R | SubscriptionLocks | SubscriptionRepository> =>
  Effect.gen(function*() {
    const locks = yield* SubscriptionLocks
    const subscriptions = yield* SubscriptionRepository
    return yield* locks.withLock(id)(
      Effect.flatMap(subscriptions.find(id), (found) =>
        Option.match(found, {
          onNone: () => Effect.succeed(Option.none<A>()),
          onSome: (subscription) => Effect.asSome(work(subscription))
        }))
    )
  })

/** The receive time of the oldest event the session has not acknowledged. */
export const oldestPending = (subscription: Subscription.Subscription) =>
  Effect.gen(function*() {
    const events = yield* EventRepository
    const pending = yield* events.list(subscription.id, subscription.ackedThrough)
    return Option.map(Arr.head(pending), (event) => event.receivedAt)
  })

const alertOnEvent = (subscription: Subscription.Subscription, event: Event.Event) =>
  Effect.gen(function*() {
    const settings = yield* (yield* SettingsStore).read.pipe(Effect.orElseSucceed(() => Settings.initial))
    const alert = Alert.forEvent(settings, subscription, event)
    if (Option.isSome(alert)) yield* Effect.ignore((yield* AlertSink).show(alert.value))
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
    yield* alertOnEvent(step.subscription, event)
    return step.subscription
  })

const apply = (before: Subscription.Subscription, item: Event.WatchItem) =>
  Effect.gen(function*() {
    if (before.state._tag !== "Active") return before
    switch (item._tag) {
      case "Event":
        return yield* admitEvent(before, item.event, Option.fromUndefinedOr(item.cursor))
      case "Cursor": {
        const subscription = { ...before, cursor: item.cursor }
        yield* commit(Option.some(before), { subscription, wake: Option.none() })
        return subscription
      }
      case "End": {
        const now = yield* DateTime.now
        const ended = Lifecycle.end(before, { _tag: "Plugin", reason: item.reason }, now)
        if (Result.isFailure(ended)) return before
        yield* commit(Option.some(before), ended.success)
        return ended.success.subscription
      }
    }
  })

const ingest = (id: Ids.SubscriptionId, item: Event.WatchItem) =>
  Effect.map(
    withSubscription(id, (before) => apply(before, item)),
    (after): Verdict => Option.exists(after, (subscription) => subscription.state._tag === "Active") ? "continue" : "stop"
  )

const lastSuspensionWake = (wakes: ReadonlyArray<Wake.Wake>) =>
  Option.map(Arr.findLast(wakes, (wake) => wake.reason === "suspended"), (wake) => wake.createdAt)

/**
 * Brings one subscription's suspended wake in line with its plugin: requests the wake the domain
 * owes, drops an undelivered one that has nothing left to say, and tells waiting callers.
 */
const followAvailability = (
  id: Ids.SubscriptionId,
  available: boolean,
  suspensionWake: (subscription: Subscription.Subscription, last: Option.Option<DateTime.Utc>) => Option.Option<Wake.Why>
) =>
  withSubscription(id, (subscription) =>
    Effect.gen(function*() {
      const wakes = yield* WakeRepository
      const all = yield* wakes.list(subscription.id)
      const stale = Arr.findFirst(all, (wake) =>
        wake.reason === "suspended" && Delivery.isUndelivered(wake) &&
        !Delivery.hasSomethingToSayWhen(wake, subscription, available))
      if (Option.isSome(stale)) yield* wakes.update({ ...stale.value, state: "dropped" })
      const why = suspensionWake(subscription, lastSuspensionWake(all))
      if (Option.isSome(why)) yield* requestWake(subscription, why.value)
      const signals = yield* SubscriptionSignals
      yield* signals.changed(subscription.id)
    }))

const subscriptionsOf = (plugin: Ids.PluginName) =>
  Effect.gen(function*() {
    const subscriptions = yield* SubscriptionRepository
    return yield* subscriptions.list({ plugin })
  })

const pluginChanged = (plugin: Plugin.Plugin) =>
  Effect.gen(function*() {
    const removed = yield* RemovedPlugins
    yield* removed.forget(plugin.name)
    const limits = yield* currentLimits
    const now = yield* DateTime.now
    const available = PluginRules.isAvailable(plugin)
    for (const subscription of yield* subscriptionsOf(plugin.name)) {
      yield* followAvailability(subscription.id, available, (current, last) =>
        Lifecycle.suspensionWake(current, plugin, last, now, limits))
    }
  })

const pluginRemoved = (plugin: Ids.PluginName, since: DateTime.Utc, problem: string) =>
  Effect.gen(function*() {
    const unavailable: Unavailable = { since, problem }
    const removed = yield* RemovedPlugins
    yield* removed.record(plugin, unavailable)
    const limits = yield* currentLimits
    const now = yield* DateTime.now
    for (const subscription of yield* subscriptionsOf(plugin)) {
      yield* followAvailability(subscription.id, false, (current, last) =>
        Lifecycle.suspensionWakeWhen(current, Option.some(unavailable), last, now, limits))
    }
  })

/** The subscription half's intake, as the plugin half's Watch streams and supervision call it. */
export const layerSubscriptionIntake: Layer.Layer<SubscriptionIntake, never, IntakeServices> = Layer.effect(
  SubscriptionIntake,
  Effect.gen(function*() {
    const context = yield* Effect.context<IntakeServices>()
    return {
      ingest: (id, item) => Effect.provideContext(ingest(id, item), context),
      pluginChanged: (plugin) => Effect.provideContext(pluginChanged(plugin), context),
      pluginRemoved: (plugin, since, problem) => Effect.provideContext(pluginRemoved(plugin, since, problem), context)
    }
  })
)
