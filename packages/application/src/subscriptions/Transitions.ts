import { Effect, Option } from "effect"
import type { Event, Subscription, Wake } from "@exangelos/domain"
import { EventRepository } from "../ports/EventRepository.ts"
import type { SettingsStore } from "../ports/SettingsStore.ts"
import { SubscriptionRepository } from "../ports/SubscriptionRepository.ts"
import type { WakeRepository } from "../ports/WakeRepository.ts"
import { ConnectorAccess } from "../seam/ConnectorAccess.ts"
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

/** The ids a subscription's log lines carry. */
export const logAnnotations = (subscription: Subscription.Subscription): Record<string, string> => ({
  subscription: subscription.id,
  connector: subscription.connector,
  ...(subscription.wakeTarget === undefined ? {} : { session: subscription.wakeTarget.sessionId })
})

const reasonOf = (state: Subscription.State): string | undefined => {
  switch (state._tag) {
    case "Paused":
      return state.reason._tag
    case "Ended":
      return state.reason._tag
    case "Cancelled":
      return state.actor._tag
    default:
      return undefined
  }
}

const logTransition = (before: Option.Option<Subscription.Subscription>, subscription: Subscription.Subscription) => {
  const from = Option.match(before, { onNone: () => "none", onSome: (previous) => previous.state._tag })
  const to = subscription.state._tag
  if (from === to) return Effect.void
  const reason = reasonOf(subscription.state)
  const backlog = subscription.state._tag === "Paused" && subscription.state.reason._tag !== "Actor"
  const message = from === "none"
    ? "subscription created"
    : to === "Active"
    ? "subscription resumed"
    : `subscription ${to.toLowerCase()}`
  return (backlog ? Effect.logWarning(message) : Effect.logInfo(message)).pipe(
    Effect.annotateLogs({ from, to, ...(reason === undefined ? {} : { reason }) })
  )
}

export type CommitServices =
  | SubscriptionRepository
  | EventRepository
  | WakeRepository
  | SettingsStore
  | ConnectorAccess
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
    const access = yield* ConnectorAccess
    if (!wasActive && isActive) yield* access.watch(subscription.id)
    if (wasActive && !isActive) yield* access.unwatch(subscription.id)
    const signals = yield* SubscriptionSignals
    yield* signals.changed(subscription.id)
    yield* logTransition(before, subscription)
  }).pipe(Effect.annotateLogs(logAnnotations(outcome.subscription)))
