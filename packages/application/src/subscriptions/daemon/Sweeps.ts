import { DateTime, Effect, Option } from "effect"
import { Lifecycle, Retention } from "@exangelos/domain"
import type { Ids } from "@exangelos/domain"
import { SubscriptionRepository } from "../../ports/SubscriptionRepository.ts"
import { currentLimits } from "../Limits.ts"
import { commit, type CommitServices } from "../Transitions.ts"
import { oldestPending } from "./Intake.ts"

/** Expires open subscriptions whose time has passed and pauses active ones whose backlog grew too old. */
export const sweepLimits: Effect.Effect<void, never, CommitServices> = Effect.gen(function*() {
  const subscriptions = yield* SubscriptionRepository
  const limits = yield* currentLimits
  const now = yield* DateTime.now
  for (const subscription of yield* subscriptions.list({ states: ["Active", "Paused"] })) {
    const oldest = yield* oldestPending(subscription)
    const step = Option.orElse(
      Lifecycle.expire(subscription, now),
      () => Lifecycle.backlog(subscription, oldest, now, limits)
    )
    if (Option.isSome(step)) yield* commit(Option.some(subscription), step.value)
  }
})

/** Deletes closed subscriptions past retention with their records, and cancels expired ones nobody resumed. */
export const sweepRetention: Effect.Effect<void, never, CommitServices> = Effect.gen(function*() {
  const subscriptions = yield* SubscriptionRepository
  const limits = yield* currentLimits
  const now = yield* DateTime.now
  const deleted: Array<Ids.SubscriptionId> = []
  for (const subscription of yield* subscriptions.list({})) {
    const decision = Retention.decide(subscription, now, limits)
    if (decision._tag === "Delete") deleted.push(subscription.id)
    if (decision._tag === "Cancel") {
      yield* commit(Option.some(subscription), { subscription: decision.subscription, wake: Option.none() })
    }
  }
  if (deleted.length > 0) yield* subscriptions.remove(deleted)
})
