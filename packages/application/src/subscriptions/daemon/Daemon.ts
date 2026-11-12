import { Effect } from "effect"
import type { Duration } from "effect"
import { deliverDue, type DeliveryServices } from "./Delivery.ts"
import { sweepLimits, sweepRetention } from "./Sweeps.ts"
import type { SweepServices } from "./Sweeps.ts"

const every = <R>(interval: Duration.Input, work: Effect.Effect<void, never, R>): Effect.Effect<never, never, R> =>
  Effect.forever(
    Effect.andThen(
      Effect.catchCause(work, (cause) => Effect.logError("Subscription daemon work failed", cause)),
      Effect.sleep(interval)
    )
  )

/**
 * The subscription half's background work: every second it applies the time limits and, in its
 * own loop so a slow session never holds them up, sends due wakes; every hour it applies
 * retention. Runs until interrupted; the daemon app forks it.
 */
export const runSubscriptionDaemon: Effect.Effect<never, never, SweepServices | DeliveryServices> = Effect.raceAll([
  every("1 second", sweepLimits),
  every("1 second", deliverDue),
  every("1 hour", sweepRetention)
])
