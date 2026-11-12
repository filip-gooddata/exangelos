import { Context } from "effect"
import type { Effect } from "effect"
import type { Event, Ids, Plugin } from "@exangelos/domain"

export type Verdict = "continue" | "stop"

/** What the subscription half offers the plugin half. */
export class SubscriptionIntake extends Context.Service<SubscriptionIntake, {
  /**
   * Applies one Watch item to the subscription through `Intake.admit` and `Lifecycle.backlog`:
   * keeps and numbers a new event with its cursor, stores a bare cursor, ends the subscription on
   * an End item, and pauses or ends it at its limits. "stop" means the subscription is no longer
   * active and its stream must stop.
   */
  readonly ingest: (subscription: Ids.SubscriptionId, item: Event.WatchItem) => Effect.Effect<Verdict>
  /**
   * The plugin record after a change to its availability, and again once its unavailable time
   * reaches `limits.unavailableBeforeWake`. Each active subscription of the plugin sends the one
   * suspended wake when `Lifecycle.suspensionWake` says so, and an undelivered suspended wake is
   * dropped once `Delivery.hasSomethingToSay` no longer holds.
   */
  readonly pluginChanged: (plugin: Plugin.Plugin) => Effect.Effect<void>
}>()("@exangelos/application/SubscriptionIntake") {}
