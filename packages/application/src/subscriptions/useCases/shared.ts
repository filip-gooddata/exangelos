import { DateTime, Effect, Option } from "effect"
import type { Ids, Lifecycle, Session, Subscribe, Subscription } from "@exangelos/domain"
import { SubscriptionRepository } from "../../ports/SubscriptionRepository.ts"
import { SubscriptionNotFound } from "../Errors.ts"
import { commit } from "../Transitions.ts"

/** Where wakes go: the calling session, a named session, or nowhere (pull-only). */
export type Target = { readonly _tag: "Caller" } | Subscribe.TargetFlag

export const targetFlag = (target: Target): Option.Option<Subscribe.TargetFlag> =>
  target._tag === "Caller" ? Option.none() : Option.some(target)

export const load = (id: Ids.SubscriptionId) =>
  Effect.gen(function*() {
    const subscriptions = yield* SubscriptionRepository
    const found = yield* subscriptions.find(id)
    if (Option.isNone(found)) return yield* new SubscriptionNotFound({ id })
    return found.value
  })

/** Stores the actor's step with its change and returns the subscription as it now is. */
export const record = (
  actor: Session.Actor,
  kind: Subscription.ChangeKind,
  before: Option.Option<Subscription.Subscription>,
  step: Lifecycle.Step,
  detail?: string
) =>
  Effect.gen(function*() {
    const at = yield* DateTime.now
    const change: Subscription.Change = {
      subscription: step.subscription.id,
      kind,
      actor,
      at,
      ...(detail === undefined ? {} : { detail })
    }
    yield* commit(before, { subscription: step.subscription, wake: step.wake, change })
    return step.subscription
  })
