import { Context } from "effect"
import type { DateTime, Effect } from "effect"
import type { Event, Ids } from "@exangelos/domain"

export type Verdict = "continue" | "stop"

/** What the subscription half offers the plugin half. */
export class SubscriptionIntake extends Context.Service<SubscriptionIntake, {
  /**
   * Applies one Watch item to the subscription: keeps and numbers a new event with its cursor,
   * stores a bare cursor, ends the subscription on an End item, and pauses or ends it at its
   * limits. "stop" means the subscription is no longer active and its stream must stop.
   */
  readonly ingest: (subscription: Ids.SubscriptionId, item: Event.WatchItem) => Effect.Effect<Verdict>
  /**
   * The plugin has been unavailable for the configured time. Each of its active subscriptions
   * sends its session the one suspended wake.
   */
  readonly suspended: (
    plugin: Ids.PluginName,
    since: DateTime.Utc,
    problem: string
  ) => Effect.Effect<void>
  /** The plugin is available again; a suspended wake that is still undelivered is dropped. */
  readonly restored: (plugin: Ids.PluginName) => Effect.Effect<void>
}>()("@exangelos/application/SubscriptionIntake") {}
