import { Context, Effect, Layer, Option, Ref } from "effect"
import type { DateTime } from "effect"
import type { Ids } from "@exangelos/domain"

export interface Unavailable {
  readonly since: DateTime.Utc
  readonly problem: string
}

/**
 * Why each removed connector is unavailable, kept in memory: a removed connector has no record to read
 * it from, and its suspended wakes need it to be sent. `connectorRemoved` fills it again after a restart.
 */
export class RemovedConnectors extends Context.Service<RemovedConnectors, {
  readonly record: (connector: Ids.ConnectorName, unavailable: Unavailable) => Effect.Effect<void>
  readonly forget: (connector: Ids.ConnectorName) => Effect.Effect<void>
  readonly find: (connector: Ids.ConnectorName) => Effect.Effect<Option.Option<Unavailable>>
}>()("@exangelos/application/RemovedConnectors") {}

export const layerRemovedConnectors: Layer.Layer<RemovedConnectors> = Layer.effect(
  RemovedConnectors,
  Effect.map(Ref.make<ReadonlyMap<Ids.ConnectorName, Unavailable>>(new Map()), (removed) => ({
    record: (connector, unavailable) => Ref.update(removed, (all) => new Map(all).set(connector, unavailable)),
    forget: (connector) =>
      Ref.update(removed, (all) => {
        const rest = new Map(all)
        rest.delete(connector)
        return rest
      }),
    find: (connector) => Effect.map(Ref.get(removed), (all) => Option.fromUndefinedOr(all.get(connector)))
  }))
)
