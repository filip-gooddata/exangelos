import { Context, Effect, Layer, Semaphore } from "effect"
import type { Ids } from "@exangelos/domain"

/**
 * Runs the work on one subscription one at a time: the stores do not serialise, so every
 * load-change-store of a subscription, its events or its wakes goes through `withLock`. Not
 * reentrant: take it once at the entry point, never inside `commit` or `requestWake`.
 */
export class SubscriptionLocks extends Context.Service<SubscriptionLocks, {
  readonly withLock: (id: Ids.SubscriptionId) => <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
}>()("@exangelos/application/SubscriptionLocks") {}

export const layerSubscriptionLocks: Layer.Layer<SubscriptionLocks> = Layer.sync(SubscriptionLocks, () => {
  const locks = new Map<Ids.SubscriptionId, Semaphore.Semaphore>()
  const lockOf = (id: Ids.SubscriptionId) => {
    const existing = locks.get(id)
    if (existing !== undefined) return existing
    const created = Semaphore.makeUnsafe(1)
    locks.set(id, created)
    return created
  }
  return {
    withLock: (id) => (effect) => Effect.suspend(() => lockOf(id).withPermits(1)(effect))
  }
})
