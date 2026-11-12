import { Context } from "effect"
import type { Effect, Option } from "effect"
import type { Ids, Wake } from "@exangelos/domain"

export class WakeRepository extends Context.Service<WakeRepository, {
  /**
   * Stores a new wake. The subscription's undelivered wake, if any, becomes replaced in the
   * same write, so a subscription has at most one undelivered wake.
   */
  readonly add: (wake: Wake.Wake) => Effect.Effect<void>
  /** Stores a changed state or attempts of a wake already added. */
  readonly update: (wake: Wake.Wake) => Effect.Effect<void>
  /** Oldest first. */
  readonly list: (subscription: Ids.SubscriptionId) => Effect.Effect<ReadonlyArray<Wake.Wake>>
  /** The subscription's waiting or sending wake. */
  readonly findUndelivered: (subscription: Ids.SubscriptionId) => Effect.Effect<Option.Option<Wake.Wake>>
  /** Every waiting or sending wake, oldest first. */
  readonly listUndelivered: Effect.Effect<ReadonlyArray<Wake.Wake>>
}>()("@exangelos/application/WakeRepository") {}
