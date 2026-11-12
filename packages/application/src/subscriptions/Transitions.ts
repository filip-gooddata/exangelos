import { Effect, Option } from "effect"
import type { Event, Subscription, Wake } from "@exangelos/domain"
import { EventRepository } from "../ports/EventRepository.ts"
import type { SettingsStore } from "../ports/SettingsStore.ts"
import { SubscriptionRepository } from "../ports/SubscriptionRepository.ts"
import type { WakeRepository } from "../ports/WakeRepository.ts"
import { PluginAccess } from "../seam/PluginAccess.ts"
import { SubscriptionSignals } from "./Signals.ts"
import { requestWake } from "./Wakes.ts"

export interface Outcome {
  readonly subscription: Subscription.Subscription
  readonly wake: Option.Option<Wake.Why>
  /** The actor's change; transitions the daemon makes by itself carry none. */
  readonly change?: Subscription.Change
  /** New events, stored in the same write as the subscription. */
  readonly events?: ReadonlyArray<Event.Event>
}

export type CommitServices =
  | SubscriptionRepository
  | EventRepository
  | WakeRepository
  | SettingsStore
  | PluginAccess
  | SubscriptionSignals

/**
 * Stores a subscription the domain changed, then follows it: requests the wake it owes, starts or
 * stops its Watch stream when it enters or leaves active, and tells waiting callers.
 */
export const commit = (
  before: Option.Option<Subscription.Subscription>,
  outcome: Outcome
): Effect.Effect<void, never, CommitServices> =>
  Effect.gen(function*() {
    const { subscription } = outcome
    if (outcome.events !== undefined && outcome.events.length > 0) {
      const events = yield* EventRepository
      yield* events.append(subscription, outcome.events)
      if (outcome.change !== undefined) {
        const subscriptions = yield* SubscriptionRepository
        yield* subscriptions.store(subscription, outcome.change)
      }
    } else {
      const subscriptions = yield* SubscriptionRepository
      yield* subscriptions.store(subscription, outcome.change)
    }
    if (Option.isSome(outcome.wake)) yield* requestWake(subscription, outcome.wake.value)
    const wasActive = Option.exists(before, (previous) => previous.state._tag === "Active")
    const isActive = subscription.state._tag === "Active"
    const access = yield* PluginAccess
    if (!wasActive && isActive) yield* access.watch(subscription.id)
    if (wasActive && !isActive) yield* access.unwatch(subscription.id)
    const signals = yield* SubscriptionSignals
    yield* signals.changed(subscription.id)
  })
