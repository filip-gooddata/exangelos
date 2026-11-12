import { Context, Effect, Layer, PubSub } from "effect"
import type { Scope } from "effect"
import type { Ids } from "@exangelos/domain"

/** Tells waiting callers that a subscription changed: a new event, an ack or a transition. */
export class SubscriptionSignals extends Context.Service<SubscriptionSignals, {
  readonly changed: (id: Ids.SubscriptionId) => Effect.Effect<void>
  /** Listens from now on; `next` returns once the subscription changes after the listen began. */
  readonly listen: (
    id: Ids.SubscriptionId
  ) => Effect.Effect<{ readonly next: Effect.Effect<void> }, never, Scope.Scope>
}>()("@exangelos/application/SubscriptionSignals") {}

export const layerSubscriptionSignals: Layer.Layer<SubscriptionSignals> = Layer.effect(
  SubscriptionSignals,
  Effect.gen(function*() {
    const hub = yield* PubSub.unbounded<Ids.SubscriptionId>()
    return {
      changed: (id) => PubSub.publish(hub, id).pipe(Effect.asVoid),
      listen: (id) =>
        Effect.map(PubSub.subscribe(hub), (subscription) => {
          const next: Effect.Effect<void> = Effect.flatMap(
            PubSub.take(subscription),
            (changed) => changed === id ? Effect.void : next
          )
          return { next }
        })
    }
  })
)
