import { Context } from "effect"
import type { DateTime, Effect } from "effect"
import type { Event, Ids, Connector } from "@exangelos/domain"

export type Verdict = "continue" | "stop"

/** What the subscription half offers the connector half. */
export class SubscriptionIntake extends Context.Service<SubscriptionIntake, {
  /**
   * Applies one Watch item to the subscription through `Intake.admit` and `Lifecycle.backlog`:
   * keeps and numbers a new event with its cursor, stores a bare cursor, ends the subscription on
   * an End item, and pauses or ends it at its limits. "stop" means the subscription is no longer
   * active and its stream must stop.
   */
  readonly ingest: (subscription: Ids.SubscriptionId, item: Event.WatchItem) => Effect.Effect<Verdict>
  /**
   * The connector record after a change to its availability, and again once its unavailable time
   * reaches `limits.unavailableBeforeWake`. Each active subscription of the connector sends the one
   * suspended wake when `Lifecycle.suspensionWake` says so, and an undelivered suspended wake is
   * dropped once `Delivery.hasSomethingToSay` no longer holds.
   */
  readonly connectorChanged: (connector: Connector.Connector) => Effect.Effect<void>
  /**
   * A connector whose record was removed, by a removal or a dev unlink. It counts as unavailable from
   * `since`: the connector's `unavailableSince` when it was already unavailable, the removal time
   * otherwise. Called once on removal and again once `since` plus `limits.unavailableBeforeWake`
   * has passed, also after a daemon restart, so a repeat with the same `since` must store nothing new.
   */
  readonly connectorRemoved: (connector: Ids.ConnectorName, since: DateTime.Utc, problem: string) => Effect.Effect<void>
  /**
   * The subscription's Watch stream failed again while its connector runs, failing since
   * `failure.since`. Called after every failed attempt; the subscription sends the one failing wake
   * when `Lifecycle.failingWake` says so.
   */
  readonly observationFailing: (subscription: Ids.SubscriptionId, failure: Connector.ObservationFailure) => Effect.Effect<void>
  /**
   * The subscription's Watch stream delivered an item after failing, or for the first time since it
   * opened. Sends the one recovered wake when the session was told of the failure, drops a failing
   * wake not yet delivered, and does nothing otherwise, so a repeat stores nothing new.
   */
  readonly observationRecovered: (subscription: Ids.SubscriptionId) => Effect.Effect<void>
}>()("@exangelos/application/SubscriptionIntake") {}
