import { Effect, Option } from "effect"
import { Subscribe } from "@exangelos/domain"
import type { Ids, Session, Subscription } from "@exangelos/domain"
import { ConnectorAccess } from "../../seam/ConnectorAccess.ts"
import { EventRepository } from "../../ports/EventRepository.ts"
import { SubscriptionRepository } from "../../ports/SubscriptionRepository.ts"
import { WakeRepository } from "../../ports/WakeRepository.ts"
import { load } from "./shared.ts"

const observationOf = (subscription: Subscription.Subscription) =>
  Effect.flatMap(ConnectorAccess, (access) => access.observation(subscription.id))

/** The calling session's own subscriptions, or every one with `all`; you see every one. */
export const list = (actor: Session.Actor, request: { readonly all: boolean }) =>
  Effect.gen(function*() {
    const subscriptions = yield* (yield* SubscriptionRepository).list({})
    const visible = request.all || actor._tag === "You"
      ? subscriptions
      : subscriptions.filter((subscription) => Subscribe.isOwn(subscription, actor.session))
    return yield* Effect.forEach(visible, (subscription) =>
      Effect.map(observationOf(subscription), (failure): Subscription.Listed =>
        Option.match(failure, {
          onNone: () => subscription,
          onSome: ({ category, since }) => ({ ...subscription, observation: { category, since } })
        })))
  })

export const show = (_actor: Session.Actor, request: { readonly id: Ids.SubscriptionId }) =>
  Effect.gen(function*() {
    const subscription = yield* load(request.id)
    return {
      subscription: Option.match(yield* observationOf(subscription), {
        onNone: (): Subscription.Shown => subscription,
        onSome: (observation): Subscription.Shown => ({ ...subscription, observation })
      }),
      events: yield* (yield* EventRepository).list(subscription.id),
      wakes: yield* (yield* WakeRepository).list(subscription.id),
      changes: yield* (yield* SubscriptionRepository).changes(subscription.id)
    }
  })

export const events = (
  _actor: Session.Actor,
  request: { readonly id: Ids.SubscriptionId; readonly after?: Ids.AckedThrough }
) =>
  Effect.gen(function*() {
    const subscription = yield* load(request.id)
    return yield* (yield* EventRepository).list(subscription.id, request.after)
  })
