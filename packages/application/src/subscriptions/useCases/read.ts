import { Effect } from "effect"
import { Subscribe } from "@exangelos/domain"
import type { Ids, Session } from "@exangelos/domain"
import { EventRepository } from "../../ports/EventRepository.ts"
import { SubscriptionRepository } from "../../ports/SubscriptionRepository.ts"
import { WakeRepository } from "../../ports/WakeRepository.ts"
import { load } from "./shared.ts"

/** The calling session's own subscriptions, or every one with `all`; you see every one. */
export const list = (actor: Session.Actor, request: { readonly all: boolean }) =>
  Effect.gen(function*() {
    const subscriptions = yield* (yield* SubscriptionRepository).list({})
    if (request.all || actor._tag === "You") return subscriptions
    return subscriptions.filter((subscription) => Subscribe.isOwn(subscription, actor.session))
  })

export const show = (request: { readonly id: Ids.SubscriptionId }) =>
  Effect.gen(function*() {
    const subscription = yield* load(request.id)
    return {
      subscription,
      events: yield* (yield* EventRepository).list(subscription.id),
      wakes: yield* (yield* WakeRepository).list(subscription.id),
      changes: yield* (yield* SubscriptionRepository).changes(subscription.id)
    }
  })

export const events = (request: { readonly id: Ids.SubscriptionId; readonly after?: Ids.AckedThrough }) =>
  Effect.gen(function*() {
    const subscription = yield* load(request.id)
    return yield* (yield* EventRepository).list(subscription.id, request.after)
  })
