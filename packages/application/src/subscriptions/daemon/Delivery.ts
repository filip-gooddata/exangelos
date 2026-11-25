import { Array as Arr, Cause, Clock, DateTime, Duration, Effect, Option } from "effect"
import { Delivery, Lifecycle, ConnectorRules } from "@exangelos/domain"
import type { Event, Ids, Limits, Connector, Session, Subscription, Wake } from "@exangelos/domain"
import { eventsForWake } from "../wakePreviews.ts"
import { EventRepository } from "../../ports/EventRepository.ts"
import { ConnectorRepository } from "../../ports/ConnectorRepository.ts"
import type { SettingsStore } from "../../ports/SettingsStore.ts"
import { SubscriptionRepository } from "../../ports/SubscriptionRepository.ts"
import { WakeRepository } from "../../ports/WakeRepository.ts"
import { DeliveryFailed, WakeTarget } from "../../ports/WakeTarget.ts"
import { currentLimits } from "../Limits.ts"
import type { SubscriptionLocks } from "../Locks.ts"
import { logAnnotations } from "../Transitions.ts"
import { withSubscription } from "./Intake.ts"
import { RemovedConnectors } from "../RemovedConnectors.ts"
import { ConnectorAccess } from "../../seam/ConnectorAccess.ts"

export type DeliveryServices =
  | WakeRepository
  | SubscriptionRepository
  | EventRepository
  | ConnectorRepository
  | WakeTarget
  | SettingsStore
  | SubscriptionLocks
  | RemovedConnectors
  | ConnectorAccess

/** How long one attempt may take before it counts as failed, so a hung session cannot stall delivery. */
export const deliveryTimeout = Duration.seconds(30)

const isDue = (wake: Wake.Wake, now: DateTime.Utc): boolean =>
  wake.attempts.nextAttemptAt === undefined || DateTime.isLessThanOrEqualTo(wake.attempts.nextAttemptAt, now)

type Decision =
  | { readonly _tag: "Send"; readonly content: Wake.WakeContent }
  | { readonly _tag: "Drop" }
  | { readonly _tag: "Wait" }

const drop: Decision = { _tag: "Drop" }
const wait: Decision = { _tag: "Wait" }

const suspensionOf = (
  subscription: Subscription.Subscription,
  connector: Option.Option<Connector.Connector>,
  now: DateTime.Utc,
  limits: Limits.Limits
) =>
  Effect.gen(function*() {
    if (Option.isSome(connector)) {
      return Option.some(Lifecycle.suspensionWake(subscription, connector.value, Option.none(), now, limits))
    }
    const removed = yield* RemovedConnectors
    const unavailable = yield* removed.find(subscription.connector)
    if (Option.isNone(unavailable)) return Option.none()
    return Option.some(Lifecycle.suspensionWakeWhen(subscription, unavailable, Option.none(), now, limits))
  })

/**
 * What to do with the wake now. A suspended wake of a removed connector waits while the connector half
 * has not yet said why it is gone after a restart.
 */
const decide = (
  wake: Wake.Wake,
  subscription: Subscription.Subscription,
  pending: ReadonlyArray<Event.Event>,
  now: DateTime.Utc,
  limits: Limits.Limits
) =>
  Effect.gen(function*() {
    const connectors = yield* ConnectorRepository
    const connector = yield* connectors.find(subscription.connector)
    const available = Option.exists(connector, ConnectorRules.isAvailable)
    const send = (content: Option.Option<Wake.WakeContent>): Decision =>
      Option.match(content, { onNone: () => drop, onSome: (c) => ({ _tag: "Send", content: c }) })
    if (!Delivery.hasSomethingToSayWhen(wake, subscription, available)) return drop
    switch (wake.reason) {
      case "events":
        return send(Option.some(Delivery.content(subscription, { _tag: "Events" }, pending)))
      case "suspended": {
        const why = yield* suspensionOf(subscription, connector, now, limits)
        if (Option.isNone(why)) return wait
        return send(Option.map(why.value, (w) => Delivery.content(subscription, w, pending)))
      }
      case "failing": {
        const failure = yield* (yield* ConnectorAccess).observation(subscription.id)
        return send(Option.map(failure, (f) => Delivery.content(subscription, { _tag: "Failing", ...f }, pending)))
      }
      case "recovered": {
        const failure = yield* (yield* ConnectorAccess).observation(subscription.id)
        if (Option.isSome(failure)) return drop
        return send(Option.some(Delivery.content(subscription, { _tag: "Recovered" }, pending)))
      }
      default:
        return send(Delivery.waitContent(subscription, pending, Option.none()))
    }
  })

interface Claim {
  readonly wake: Wake.Wake
  readonly session: Session.Target
  readonly content: Wake.WakeContent
}

const findWake = (subscription: Ids.SubscriptionId, id: Ids.WakeId) =>
  Effect.gen(function*() {
    const wakes = yield* WakeRepository
    return Arr.findFirst(yield* wakes.list(subscription), (wake) => wake.id === id)
  })

/** Under the subscription's lock: marks the wake sending when it has something to say, else drops it. */
const claim = (listed: Wake.Wake, now: DateTime.Utc, limits: Limits.Limits) =>
  Effect.map(
    withSubscription(listed.subscription, (subscription) =>
      Effect.gen(function*() {
        const latest = Option.filter(yield* findWake(subscription.id, listed.id), Delivery.isUndelivered)
        if (Option.isNone(latest) || subscription.wakeTarget === undefined) return Option.none<Claim>()
        const wake = latest.value
        const events = yield* EventRepository
        const pending = yield* eventsForWake(subscription.connector, yield* events.list(subscription.id, subscription.ackedThrough))
        const decision = yield* decide(wake, subscription, pending, now, limits)
        const wakes = yield* WakeRepository
        if (decision._tag === "Wait") return Option.none<Claim>()
        if (decision._tag === "Drop") {
          yield* wakes.update({ ...wake, state: "dropped" })
          yield* Effect.logDebug("wake dropped").pipe(Effect.annotateLogs(logAnnotations(subscription)))
          return Option.none<Claim>()
        }
        const sending: Wake.Wake = { ...wake, state: "sending" }
        yield* wakes.update(sending)
        return Option.some<Claim>({ wake: sending, session: subscription.wakeTarget, content: decision.content })
      })),
    Option.flatten
  )

/** Under the subscription's lock: stores the outcome while the wake is still being sent; a newer wake or a drop wins. */
const settle = (wake: Wake.Wake) =>
  withSubscription(wake.subscription, () =>
    Effect.gen(function*() {
      if (!Option.exists(yield* findWake(wake.subscription, wake.id), (current) => current.state === "sending")) return
      const wakes = yield* WakeRepository
      yield* wakes.update(wake)
    }))

const attempt = (listed: Wake.Wake, now: DateTime.Utc, limits: Limits.Limits) =>
  Effect.gen(function*() {
    const claimed = yield* claim(listed, now, limits)
    if (Option.isNone(claimed)) return
    const { content, session, wake } = claimed.value
    const sender = yield* WakeTarget
    const started = yield* Clock.currentTimeMillis
    const elapsed = Effect.map(Clock.currentTimeMillis, (now) => now - started)
    yield* sender.deliver(session, content).pipe(
      Effect.timeoutOrElse({
        duration: deliveryTimeout,
        orElse: () => {
          const failure = new DeliveryFailed({ reason: "timed out" })
          return Effect.logWarning("wake timed out", Cause.fail(failure)).pipe(
            Effect.annotateLogs("error", failure.reason),
            Effect.andThen(Effect.fail(failure))
          )
        }
      }),
      Effect.andThen(Effect.flatMap(elapsed, (durationMs) =>
        Effect.logInfo("wake delivered").pipe(Effect.annotateLogs({ outcome: "ok", durationMs })))),
      Effect.andThen(settle({ ...wake, state: "delivered" })),
      Effect.catchTag("DeliveryFailed", (failure) =>
        elapsed.pipe(
          Effect.flatMap((durationMs) =>
            Effect.logInfo("wake not delivered").pipe(
              Effect.annotateLogs({ outcome: "error", durationMs, attempt: wake.attempts.count + 1 })
            )),
          Effect.andThen(DateTime.now),
          Effect.flatMap((failedAt) => settle(Delivery.retry(wake, failure.reason, failedAt, limits)))
        )),
      Effect.annotateLogs({ connector: content.connector, session: session.sessionId, target: session.harness })
    )
  }).pipe(Effect.annotateLogs({ subscription: listed.subscription, wake: listed.id, reason: listed.reason }))

/**
 * Sends every undelivered wake whose time has come, drops one with nothing left to say, and puts a
 * failed one back with its next attempt pushed out. A failure raises no alert.
 */
export const deliverDue: Effect.Effect<void, never, DeliveryServices> = Effect.gen(function*() {
  const wakes = yield* WakeRepository
  const limits = yield* currentLimits
  const now = yield* DateTime.now
  for (const wake of yield* wakes.listUndelivered) {
    if (isDue(wake, now)) yield* attempt(wake, now, limits)
  }
})
