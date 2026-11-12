import { Array as Arr, DateTime, Duration, Effect, Option } from "effect"
import { Delivery, Lifecycle, PluginRules } from "@exangelos/domain"
import type { Event, Ids, Limits, Plugin, Session, Subscription, Wake } from "@exangelos/domain"
import { EventRepository } from "../../ports/EventRepository.ts"
import { PluginRepository } from "../../ports/PluginRepository.ts"
import type { SettingsStore } from "../../ports/SettingsStore.ts"
import { SubscriptionRepository } from "../../ports/SubscriptionRepository.ts"
import { WakeRepository } from "../../ports/WakeRepository.ts"
import { DeliveryFailed, WakeTarget } from "../../ports/WakeTarget.ts"
import { currentLimits } from "../Limits.ts"
import type { SubscriptionLocks } from "../Locks.ts"
import { withSubscription } from "./Intake.ts"
import { RemovedPlugins } from "../RemovedPlugins.ts"

export type DeliveryServices =
  | WakeRepository
  | SubscriptionRepository
  | EventRepository
  | PluginRepository
  | WakeTarget
  | SettingsStore
  | SubscriptionLocks
  | RemovedPlugins

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
  plugin: Option.Option<Plugin.Plugin>,
  now: DateTime.Utc,
  limits: Limits.Limits
) =>
  Effect.gen(function*() {
    if (Option.isSome(plugin)) {
      return Option.some(Lifecycle.suspensionWake(subscription, plugin.value, Option.none(), now, limits))
    }
    const removed = yield* RemovedPlugins
    const unavailable = yield* removed.find(subscription.plugin)
    if (Option.isNone(unavailable)) return Option.none()
    return Option.some(Lifecycle.suspensionWakeWhen(subscription, unavailable, Option.none(), now, limits))
  })

/**
 * What to do with the wake now. A suspended wake of a removed plugin waits while the plugin half
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
    const plugins = yield* PluginRepository
    const plugin = yield* plugins.find(subscription.plugin)
    const available = Option.exists(plugin, PluginRules.isAvailable)
    const send = (content: Option.Option<Wake.WakeContent>): Decision =>
      Option.match(content, { onNone: () => drop, onSome: (c) => ({ _tag: "Send", content: c }) })
    if (!Delivery.hasSomethingToSayWhen(wake, subscription, available)) return drop
    switch (wake.reason) {
      case "events":
        return send(Option.some(Delivery.content(subscription, { _tag: "Events" }, pending)))
      case "suspended": {
        const why = yield* suspensionOf(subscription, plugin, now, limits)
        if (Option.isNone(why)) return wait
        return send(Option.map(why.value, (w) => Delivery.content(subscription, w, pending)))
      }
      default:
        return send(Delivery.waitContent(subscription, pending, Option.none()))
    }
  })

interface Claim {
  readonly wake: Wake.Wake
  readonly session: Session.Session
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
        const pending = yield* events.list(subscription.id, subscription.ackedThrough)
        const decision = yield* decide(wake, subscription, pending, now, limits)
        const wakes = yield* WakeRepository
        if (decision._tag === "Wait") return Option.none<Claim>()
        if (decision._tag === "Drop") {
          yield* wakes.update({ ...wake, state: "dropped" })
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
    yield* sender.deliver(session, content).pipe(
      Effect.timeoutOrElse({
        duration: deliveryTimeout,
        orElse: () => Effect.fail(new DeliveryFailed({ reason: "timed out" }))
      }),
      Effect.andThen(settle({ ...wake, state: "delivered" })),
      Effect.catchTag("DeliveryFailed", (failure) =>
        Effect.flatMap(DateTime.now, (failedAt) => settle(Delivery.retry(wake, failure.reason, failedAt, limits))))
    )
  })

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
