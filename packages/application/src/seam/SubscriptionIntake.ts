import { Context } from "effect"
import type { DateTime, Effect } from "effect"
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
  /**
   * A plugin whose record was removed, by a removal or a dev unlink. It counts as unavailable from
   * `since`: the plugin's `unavailableSince` when it was already unavailable, the removal time
   * otherwise. Called once on removal and again once `since` plus `limits.unavailableBeforeWake`
   * has passed, also after a daemon restart, so a repeat with the same `since` must store nothing new.
   */
  readonly pluginRemoved: (plugin: Ids.PluginName, since: DateTime.Utc, problem: string) => Effect.Effect<void>
}>()("@exangelos/application/SubscriptionIntake") {}
