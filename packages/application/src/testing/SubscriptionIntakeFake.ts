import { Context, type DateTime, Effect, Layer, Ref } from "effect"
import type { Event, Ids, Connector } from "@exangelos/domain"
import { SubscriptionIntake, type Verdict } from "../seam/SubscriptionIntake.ts"

export class SubscriptionIntakeFake extends Context.Service<SubscriptionIntakeFake, {
  /** Items ingested per subscription, in order. */
  readonly ingested: (subscription: Ids.SubscriptionId) => Effect.Effect<ReadonlyArray<Event.WatchItem>>
  /** From now on `ingest` answers "stop" for the subscription, as when it reached a limit. */
  readonly stop: (subscription: Ids.SubscriptionId) => Effect.Effect<void>
  /** Connector records passed to `connectorChanged`, in order. */
  readonly connectorChanges: Effect.Effect<ReadonlyArray<Connector.Connector>>
  /** Calls to `connectorRemoved`, in order. */
  readonly connectorRemovals: Effect.Effect<ReadonlyArray<Removal>>
  /** Calls to `observationFailing` (with a failure) and `observationRecovered` (without), in order. */
  readonly observations: Effect.Effect<ReadonlyArray<ObservationReport>>
}>()("@exangelos/application/testing/SubscriptionIntakeFake") {}

export interface ObservationReport {
  readonly subscription: Ids.SubscriptionId
  readonly failure?: Connector.ObservationFailure
}

export interface Removal {
  readonly connector: Ids.ConnectorName
  readonly since: DateTime.Utc
  readonly problem: string
}

/** `ingest` answers "stop" for an End item or a stopped subscription, "continue" otherwise. */
export const layerSubscriptionIntake: Layer.Layer<SubscriptionIntake | SubscriptionIntakeFake> = Layer.unwrap(
  Effect.gen(function*() {
    const items = yield* Ref.make<ReadonlyArray<{ readonly subscription: Ids.SubscriptionId; readonly item: Event.WatchItem }>>([])
    const stopped = yield* Ref.make<ReadonlySet<Ids.SubscriptionId>>(new Set())
    const connectorChanges = yield* Ref.make<ReadonlyArray<Connector.Connector>>([])
    const removals = yield* Ref.make<ReadonlyArray<Removal>>([])
    const observations = yield* Ref.make<ReadonlyArray<ObservationReport>>([])
    return Layer.merge(
      Layer.succeed(SubscriptionIntake, {
        ingest: (subscription, item) =>
          Effect.gen(function*() {
            yield* Ref.update(items, (all) => [...all, { subscription, item }])
            const isStopped = (yield* Ref.get(stopped)).has(subscription)
            const verdict: Verdict = isStopped || item._tag === "End" ? "stop" : "continue"
            return verdict
          }),
        connectorChanged: (connector) => Ref.update(connectorChanges, (all) => [...all, connector]),
        connectorRemoved: (connector, since, problem) => Ref.update(removals, (all) => [...all, { connector, since, problem }]),
        observationFailing: (subscription, failure) =>
          Ref.update(observations, (all) => [...all, { subscription, failure }]),
        observationRecovered: (subscription) => Ref.update(observations, (all) => [...all, { subscription }])
      }),
      Layer.succeed(SubscriptionIntakeFake, {
        ingested: (subscription) =>
          Effect.map(Ref.get(items), (all) => all.filter((entry) => entry.subscription === subscription).map((entry) => entry.item)),
        stop: (subscription) => Ref.update(stopped, (all) => new Set(all).add(subscription)),
        connectorChanges: Ref.get(connectorChanges),
        connectorRemovals: Ref.get(removals),
        observations: Ref.get(observations)
      })
    )
  })
)
