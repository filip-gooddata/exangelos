import { DateTime, Effect, Option } from "effect"
import { Lifecycle, Retention } from "@exangelos/domain"
import { SubscriptionRepository } from "../../ports/SubscriptionRepository.ts"
import { currentLimits } from "../Limits.ts"
import type { SubscriptionLocks } from "../Locks.ts"
import { commit, type CommitServices } from "../Transitions.ts"
import { oldestPending, withSubscription } from "./Intake.ts"

export type SweepServices = CommitServices | SubscriptionLocks

/** Expires open subscriptions whose time has passed and pauses active ones whose backlog grew too old. */
export const sweepLimits: Effect.Effect<void, never, SweepServices> = Effect.gen(function*() {
  const subscriptions = yield* SubscriptionRepository
  const limits = yield* currentLimits
  const now = yield* DateTime.now
  for (const listed of yield* subscriptions.list({ states: ["Active", "Paused"] })) {
    yield* withSubscription(listed.id, (subscription) =>
      Effect.gen(function*() {
        const oldest = yield* oldestPending(subscription)
        const step = Option.orElse(
          Lifecycle.expire(subscription, now),
          () => Lifecycle.backlog(subscription, oldest, now, limits)
        )
        if (Option.isSome(step)) yield* commit(Option.some(subscription), step.value)
      }))
  }
})

/** Deletes closed subscriptions past retention with their records, and cancels expired ones nobody resumed. */
export const sweepRetention: Effect.Effect<void, never, SweepServices> = Effect.gen(function*() {
  const subscriptions = yield* SubscriptionRepository
  const limits = yield* currentLimits
  const now = yield* DateTime.now
  for (const listed of yield* subscriptions.list({})) {
    yield* withSubscription(listed.id, (subscription) =>
      Effect.gen(function*() {
        const decision = Retention.decide(subscription, now, limits)
        if (decision._tag === "Delete") yield* subscriptions.remove([subscription.id])
        if (decision._tag === "Cancel") {
          yield* commit(Option.some(subscription), { subscription: decision.subscription, wake: Option.none() })
        }
      }))
  }
})
