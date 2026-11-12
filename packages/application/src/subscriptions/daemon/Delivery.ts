import { Array as Arr, DateTime, Effect, Option } from "effect"
import { Delivery, Lifecycle } from "@exangelos/domain"
import type { Event, Limits, Plugin, Subscription, Wake } from "@exangelos/domain"
import { EventRepository } from "../../ports/EventRepository.ts"
import { PluginRepository } from "../../ports/PluginRepository.ts"
import type { SettingsStore } from "../../ports/SettingsStore.ts"
import { SubscriptionRepository } from "../../ports/SubscriptionRepository.ts"
import { WakeRepository } from "../../ports/WakeRepository.ts"
import { WakeTarget } from "../../ports/WakeTarget.ts"
import { currentLimits } from "../Limits.ts"

export type DeliveryServices =
  | WakeRepository
  | SubscriptionRepository
  | EventRepository
  | PluginRepository
  | WakeTarget
  | SettingsStore

const isDue = (wake: Wake.Wake, now: DateTime.Utc): boolean =>
  wake.attempts.nextAttemptAt === undefined || DateTime.isLessThanOrEqualTo(wake.attempts.nextAttemptAt, now)

const contentOf = (
  wake: Wake.Wake,
  subscription: Subscription.Subscription,
  plugin: Plugin.Plugin,
  pending: ReadonlyArray<Event.Event>,
  now: DateTime.Utc,
  limits: Limits.Limits
): Option.Option<Wake.WakeContent> => {
  if (!Delivery.hasSomethingToSay(wake, subscription, plugin)) return Option.none()
  switch (wake.reason) {
    case "events":
      return Option.some(Delivery.content(subscription, { _tag: "Events" }, pending))
    case "suspended":
      return Option.map(
        Lifecycle.suspensionWake(subscription, plugin, Option.none(), now, limits),
        (why) => Delivery.content(subscription, why, pending)
      )
    default:
      return Delivery.waitContent(subscription, pending, Option.none())
  }
}

const stored = (wake: Wake.Wake) =>
  Effect.gen(function*() {
    const wakes = yield* WakeRepository
    return Arr.findFirst(yield* wakes.list(wake.subscription), (other) => other.id === wake.id)
  })

/** Stores the attempt's outcome unless a newer wake replaced this one meanwhile. */
const settle = (wake: Wake.Wake) =>
  Effect.gen(function*() {
    if (Option.exists(yield* stored(wake), (current) => current.state === "replaced")) return
    const wakes = yield* WakeRepository
    yield* wakes.update(wake)
  })

const attempt = (listed: Wake.Wake, now: DateTime.Utc, limits: Limits.Limits) =>
  Effect.gen(function*() {
    const latest = Option.filter(yield* stored(listed), Delivery.isUndelivered)
    if (Option.isNone(latest)) return
    const wake = latest.value
    const subscriptions = yield* SubscriptionRepository
    const plugins = yield* PluginRepository
    const events = yield* EventRepository
    const wakes = yield* WakeRepository
    const sender = yield* WakeTarget
    const found = yield* subscriptions.find(wake.subscription)
    if (Option.isNone(found)) return
    const subscription = found.value
    const plugin = yield* plugins.find(subscription.plugin)
    const target = subscription.wakeTarget
    if (Option.isNone(plugin)) yield* Effect.logWarning("Wake dropped, its plugin is not stored", wake.id)
    const pending = yield* events.list(subscription.id, subscription.ackedThrough)
    const content = Option.flatMap(plugin, (p) => contentOf(wake, subscription, p, pending, now, limits))
    if (target === undefined || Option.isNone(content)) {
      return yield* wakes.update({ ...wake, state: "dropped" })
    }
    yield* wakes.update({ ...wake, state: "sending" })
    yield* sender.deliver(target, content.value).pipe(
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
