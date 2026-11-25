import { Array as Arr, DateTime, Effect, Layer, Option, Result } from "effect"
import { Alert, Delivery, Intake, Lifecycle, ConnectorRules, Settings } from "@exangelos/domain"
import type { Event, Ids, Connector, Subscription, Wake } from "@exangelos/domain"
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
import { commit, type CommitServices, logAnnotations } from "../Transitions.ts"
import { requestWake } from "../Wakes.ts"
import { RemovedConnectors, type Unavailable } from "../RemovedConnectors.ts"
import { ConnectorAccess } from "../../seam/ConnectorAccess.ts"

export type IntakeServices = CommitServices | SubscriptionLocks | RemovedConnectors | AlertSink

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
      yield* Effect.logDebug(duplicate ? "event dropped as duplicate" : "event not admitted").pipe(
        Effect.annotateLogs({ type: reported.type, payload: { dedupeKey: reported.dedupeKey } })
      )
      if (admission.subscription !== before) yield* commit(Option.some(before), { ...admission, wake: Option.none() })
      return { subscription: admission.subscription, stored: Option.none<Event.Event>() }
    }
    const event = admission.event.value
    const limits = yield* currentLimits
    const oldest = Option.orElse(yield* oldestPending(before), () => Option.some(event.receivedAt))
    const step = Option.getOrElse(
      Lifecycle.backlog(admission.subscription, oldest, now, limits),
      () => admission
    )
    yield* commit(Option.some(before), { subscription: step.subscription, wake: step.wake, events: [event] })
    yield* Effect.logInfo("event received").pipe(
      Effect.annotateLogs({ event: event.id, number: event.number, type: event.type })
    )
    yield* Effect.logDebug("event payload").pipe(
      Effect.annotateLogs({
        event: event.id,
        payload: { summary: event.summary, payload: event.payload, link: event.link, dedupeKey: event.dedupeKey }
      })
    )
    return { subscription: step.subscription, stored: Option.some(event) }
  })

const unchanged = (subscription: Subscription.Subscription) => ({ subscription, stored: Option.none<Event.Event>() })

const apply = (before: Subscription.Subscription, item: Event.WatchItem) =>
  Effect.gen(function*() {
    if (before.state._tag !== "Active") {
      yield* Effect.logDebug("watch item ignored").pipe(Effect.annotateLogs({ item: item._tag, state: before.state._tag }))
      return unchanged(before)
    }
    switch (item._tag) {
      case "Event":
        return yield* admitEvent(before, item.event, Option.fromUndefinedOr(item.cursor))
      case "Cursor": {
        if (item.cursor === before.cursor) return unchanged(before)
        const subscription = { ...before, cursor: item.cursor }
        yield* commit(Option.some(before), { subscription, wake: Option.none() })
        yield* Effect.logDebug("cursor advanced")
        return unchanged(subscription)
      }
      case "End": {
        const now = yield* DateTime.now
        const ended = Lifecycle.end(before, { _tag: "Connector", reason: item.reason }, now)
        if (Result.isFailure(ended)) {
          yield* Effect.logDebug("end ignored")
          return unchanged(before)
        }
        yield* commit(Option.some(before), ended.success)
        return unchanged(ended.success.subscription)
      }
    }
  }).pipe(Effect.annotateLogs(logAnnotations(before)))

const ingest = (id: Ids.SubscriptionId, item: Event.WatchItem) =>
  Effect.gen(function*() {
    const outcome = yield* withSubscription(id, (before) => apply(before, item))
    if (Option.isSome(outcome) && Option.isSome(outcome.value.stored)) {
      yield* alertOnEvent(outcome.value.subscription, outcome.value.stored.value)
    }
    const verdict: Verdict = Option.exists(outcome, ({ subscription }) => subscription.state._tag === "Active")
      ? "continue"
      : "stop"
    return verdict
  }).pipe(Effect.annotateLogs("subscription", id))

const lastSuspensionWake = (wakes: ReadonlyArray<Wake.Wake>) =>
  Option.map(Arr.findLast(wakes, (wake) => wake.reason === "suspended"), (wake) => wake.createdAt)

/**
 * Brings one subscription's suspended wake in line with its connector: requests the wake the domain
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
      if (Option.isSome(stale)) {
        yield* wakes.update({ ...stale.value, state: "dropped" })
        yield* Effect.logDebug("suspended wake dropped").pipe(Effect.annotateLogs("wake", stale.value.id))
      }
      const why = suspensionWake(subscription, lastSuspensionWake(all))
      if (Option.isSome(why)) {
        yield* requestWake(subscription, why.value)
        yield* Effect.logInfo("suspension wake requested").pipe(Effect.annotateLogs("reason", why.value._tag))
      }
      const signals = yield* SubscriptionSignals
      yield* signals.changed(subscription.id)
    }).pipe(Effect.annotateLogs(logAnnotations(subscription))))

const subscriptionsOf = (connector: Ids.ConnectorName) =>
  Effect.gen(function*() {
    const subscriptions = yield* SubscriptionRepository
    return yield* subscriptions.list({ connector })
  })

const connectorChanged = (connector: Connector.Connector) =>
  Effect.gen(function*() {
    const removed = yield* RemovedConnectors
    yield* removed.forget(connector.name)
    const limits = yield* currentLimits
    const now = yield* DateTime.now
    const available = ConnectorRules.isAvailable(connector)
    for (const subscription of yield* subscriptionsOf(connector.name)) {
      yield* followAvailability(subscription.id, available, (current, last) =>
        Lifecycle.suspensionWake(current, connector, last, now, limits))
    }
  }).pipe(Effect.annotateLogs("connector", connector.name))

const connectorRemoved = (connector: Ids.ConnectorName, since: DateTime.Utc, problem: string) =>
  Effect.gen(function*() {
    const unavailable: Unavailable = { since, problem }
    const removed = yield* RemovedConnectors
    yield* removed.record(connector, unavailable)
    const limits = yield* currentLimits
    const now = yield* DateTime.now
    for (const subscription of yield* subscriptionsOf(connector)) {
      yield* followAvailability(subscription.id, false, (current, last) =>
        Lifecycle.suspensionWakeWhen(current, Option.some(unavailable), last, now, limits))
    }
  }).pipe(Effect.annotateLogs("connector", connector))

/** The latest failing wake still standing, or recovered wake the session got. */
const latestObservationWake = (wakes: ReadonlyArray<Wake.Wake>) =>
  Arr.findLast(wakes, (wake) =>
    (wake.reason === "failing" && wake.state !== "dropped" && wake.state !== "replaced") ||
    (wake.reason === "recovered" && wake.state === "delivered"))

/** Waits while another wake is queued, so a failing wake never replaces pending events; the next failure tries again. */
const observationFailing = (id: Ids.SubscriptionId, failure: Connector.ObservationFailure) =>
  withSubscription(id, (subscription) =>
    Effect.gen(function*() {
      const wakes = yield* WakeRepository
      if (Option.isSome(yield* wakes.findUndelivered(subscription.id))) return
      const all = yield* wakes.list(subscription.id)
      const history: Lifecycle.FailingHistory = {
        unresolved: Option.exists(latestObservationWake(all), (wake) => wake.reason === "failing"),
        lastFailingWake: Option.map(Arr.findLast(all, (wake) => wake.reason === "failing"), (wake) => wake.createdAt)
      }
      const why = Lifecycle.failingWake(subscription, failure, history, yield* DateTime.now)
      if (Option.isNone(why)) return
      yield* requestWake(subscription, why.value)
      yield* Effect.logInfo("failing wake requested").pipe(Effect.annotateLogs("category", failure.category))
    }).pipe(Effect.annotateLogs(logAnnotations(subscription))))

/**
 * Requests the recovered wake the session is owed: its latest observation wake delivered is a failing
 * one, the stream reads again, and no other wake is queued, which goes first and leads back here.
 */
const followRecoveryLocked = (subscription: Subscription.Subscription) =>
  Effect.gen(function*() {
    if (subscription.state._tag !== "Active") return
    const wakes = yield* WakeRepository
    if (Option.isSome(yield* wakes.findUndelivered(subscription.id))) return
    const told = Arr.findLast(
      yield* wakes.list(subscription.id),
      (wake) => wake.state === "delivered" && (wake.reason === "failing" || wake.reason === "recovered")
    )
    if (!Option.exists(told, (wake) => wake.reason === "failing")) return
    if (!(yield* (yield* ConnectorAccess).reading(subscription.id))) return
    yield* requestWake(subscription, { _tag: "Recovered" })
    yield* Effect.logInfo("recovered wake requested")
  }).pipe(Effect.annotateLogs(logAnnotations(subscription)))

/** Follows the subscription's recovered wake after a delivery attempt frees its queue. */
export const followRecovery = (id: Ids.SubscriptionId) => Effect.asVoid(withSubscription(id, followRecoveryLocked))

/** Drops a failing wake not yet sent, which has nothing left to say, then follows the recovered wake. */
const observationRecovered = (id: Ids.SubscriptionId) =>
  withSubscription(id, (subscription) =>
    Effect.gen(function*() {
      const wakes = yield* WakeRepository
      const waiting = Option.filter(yield* wakes.findUndelivered(subscription.id), (wake) =>
        wake.reason === "failing" && wake.state === "waiting")
      if (Option.isSome(waiting)) {
        yield* wakes.update({ ...waiting.value, state: "dropped" })
        yield* Effect.logDebug("failing wake dropped").pipe(Effect.annotateLogs("wake", waiting.value.id))
      }
      yield* followRecoveryLocked(subscription)
    }))

/** The subscription half's intake, as the connector half's Watch streams and supervision call it. */
export const layerSubscriptionIntake: Layer.Layer<SubscriptionIntake, never, IntakeServices> = Layer.effect(
  SubscriptionIntake,
  Effect.gen(function*() {
    const context = yield* Effect.context<IntakeServices>()
    return {
      ingest: (id, item) => Effect.provideContext(ingest(id, item), context),
      connectorChanged: (connector) => Effect.provideContext(connectorChanged(connector), context),
      connectorRemoved: (connector, since, problem) => Effect.provideContext(connectorRemoved(connector, since, problem), context),
      observationFailing: (id, failure) => Effect.provideContext(Effect.asVoid(observationFailing(id, failure)), context),
      observationRecovered: (id) => Effect.provideContext(Effect.asVoid(observationRecovered(id)), context)
    }
  })
)
