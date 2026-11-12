import { DateTime, Effect, Option } from "effect"
import { Lifecycle, Subscribe } from "@exangelos/domain"
import type { Ids, Session, Subscription } from "@exangelos/domain"
import { EventRepository } from "../../ports/EventRepository.ts"
import { currentLimits } from "../Limits.ts"
import { load, record, type Target, targetFlag } from "./shared.ts"

interface ById {
  readonly id: Ids.SubscriptionId
}

export const pause = (actor: Session.Actor, request: ById) =>
  Effect.gen(function*() {
    const subscription = yield* load(request.id)
    const step = yield* Effect.fromResult(Lifecycle.pause(subscription, actor, yield* DateTime.now))
    return yield* record(actor, "pause", Option.some(subscription), step)
  })

/** Restarts a paused or expired subscription with a fresh expiry; refused while the backlog is over the limit. */
export const resume = (actor: Session.Actor, request: ById) =>
  Effect.gen(function*() {
    const subscription = yield* load(request.id)
    const pending = yield* (yield* EventRepository).list(subscription.id, subscription.ackedThrough)
    const oldestPending = Option.fromNullishOr(pending[0]?.receivedAt)
    const step = yield* Effect.fromResult(
      Lifecycle.resume(subscription, oldestPending, yield* DateTime.now, yield* currentLimits)
    )
    return yield* record(actor, "resume", Option.some(subscription), step)
  })

export const cancel = (actor: Session.Actor, request: ById) =>
  Effect.gen(function*() {
    const subscription = yield* load(request.id)
    const step = yield* Effect.fromResult(Lifecycle.cancel(subscription, actor, yield* DateTime.now))
    return yield* record(actor, "cancel", Option.some(subscription), step)
  })

/** Sends the subscription's later wakes to another session, or to none. */
export const retarget = (
  actor: Session.Actor,
  request: ById & { readonly target: Target },
  detected: ReadonlyArray<Session.Session>
) =>
  Effect.gen(function*() {
    const subscription = yield* load(request.id)
    const target = yield* Effect.fromResult(Subscribe.wakeTarget(detected, targetFlag(request.target)))
    const { wakeTarget: _previous, ...rest } = subscription
    const retargeted: Subscription.Subscription = Option.match(target, {
      onNone: () => rest,
      onSome: (wakeTarget) => ({ ...rest, wakeTarget })
    })
    return yield* record(actor, "retarget", Option.some(subscription), {
      subscription: retargeted,
      wake: Option.none()
    })
  })
