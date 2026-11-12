import { DateTime, Effect } from "effect"
import { Delivery } from "@exangelos/domain"
import type { Subscription, Wake } from "@exangelos/domain"
import * as NewId from "../NewId.ts"
import type { SettingsStore } from "../ports/SettingsStore.ts"
import { WakeRepository } from "../ports/WakeRepository.ts"
import { currentLimits } from "./Limits.ts"

/**
 * Records the wake the subscription now owes its session, replacing or extending its undelivered
 * one as the domain plans. A pull-only subscription gets none; `wait` answers it.
 */
export const requestWake = (
  subscription: Subscription.Subscription,
  why: Wake.Why
): Effect.Effect<void, never, WakeRepository | SettingsStore> =>
  Effect.gen(function*() {
    if (subscription.wakeTarget === undefined) return
    const wakes = yield* WakeRepository
    const limits = yield* currentLimits
    const current = yield* wakes.findUndelivered(subscription.id)
    const id = yield* NewId.wakeId
    const now = yield* DateTime.now
    for (const wake of Delivery.plan(current, { id, why, subscription, now }, limits)) {
      if (wake.id === id) yield* wakes.add(wake)
      else if (wake.state !== "replaced") yield* wakes.update(wake)
    }
  })

