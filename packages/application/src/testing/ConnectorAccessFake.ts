import { Context, Effect, Layer, Option, Ref } from "effect"
import { Subscribe } from "@exangelos/domain"
import type { Catalogue, Connector, Ids, Refusal } from "@exangelos/domain"
import type { OfficialFetchFailed } from "../ports/OfficialConnectorSource.ts"
import { ConnectorAccess, ConnectorNotFound, type Described } from "../seam/ConnectorAccess.ts"

/** Answers for parameters that already carry the main parameter. */
export type Describe = (
  parameters: Catalogue.Parameters
) => Effect.Effect<Described, Refusal.ConnectorUnavailable | Refusal.ParametersInvalid | OfficialFetchFailed>

export interface AccessScript {
  readonly catalogue: Catalogue.Catalogue
  /** Makes the connector ready, before `main` is joined; ready by default. */
  readonly ready?: Effect.Effect<void, Refusal.ConnectorUnavailable | OfficialFetchFailed>
  readonly describe: Describe
}

export class ConnectorAccessFake extends Context.Service<ConnectorAccessFake, {
  /**
   * How `describe` answers for the connector: `ready` runs first, then `main` is joined under the
   * catalogue's main parameter, then `describe`; an unknown connector is not found.
   */
  readonly define: (connector: Ids.ConnectorName, script: AccessScript) => Effect.Effect<void>
  /** Subscriptions currently watched, in the order `watch` was first called. */
  readonly watched: Effect.Effect<ReadonlyArray<Ids.SubscriptionId>>
  /** Subscriptions passed to `rewatch`, one entry per call. */
  readonly rewatched: Effect.Effect<ReadonlyArray<Ids.SubscriptionId>>
  /** Sets what `observation` answers for the subscription; undefined clears it. */
  readonly observe: (subscription: Ids.SubscriptionId, failure: Connector.ObservationFailure | undefined) => Effect.Effect<void>
}>()("@exangelos/application/testing/ConnectorAccessFake") {}

export const layerConnectorAccess: Layer.Layer<ConnectorAccess | ConnectorAccessFake> = Layer.unwrap(Effect.gen(function*() {
  const connectors = yield* Ref.make<ReadonlyMap<Ids.ConnectorName, AccessScript>>(new Map())
  const watched = yield* Ref.make<ReadonlyArray<Ids.SubscriptionId>>([])
  const rewatched = yield* Ref.make<ReadonlyArray<Ids.SubscriptionId>>([])
  const observations = yield* Ref.make<ReadonlyMap<Ids.SubscriptionId, Connector.ObservationFailure>>(new Map())
  return Layer.merge(
    Layer.succeed(ConnectorAccess, {
      describe: (_actor, connector, { main, parameters }) =>
        Effect.gen(function*() {
          const script = (yield* Ref.get(connectors)).get(connector)
          if (script === undefined) {
            return yield* new ConnectorNotFound({ connector })
          }
          if (script.ready !== undefined) {
            yield* script.ready
          }
          const joined = yield* Effect.fromResult(Subscribe.withMain(parameters, script.catalogue.parameters.main, main))
          return yield* script.describe(joined)
        }),
      watch: (subscription) =>
        Ref.update(watched, (all) => all.includes(subscription) ? all : [...all, subscription]),
      unwatch: (subscription) => Ref.update(watched, (all) => all.filter((id) => id !== subscription)),
      rewatch: (subscription) => Ref.update(rewatched, (all) => [...all, subscription]),
      observation: (subscription) => Effect.map(Ref.get(observations), (all) => Option.fromUndefinedOr(all.get(subscription))),
      reading: (subscription) => Effect.map(Ref.get(observations), (all) => !all.has(subscription))
    }),
    Layer.succeed(ConnectorAccessFake, {
      define: (connector, script) => Ref.update(connectors, (all) => new Map(all).set(connector, script)),
      watched: Ref.get(watched),
      rewatched: Ref.get(rewatched),
      observe: (subscription, failure) =>
        Ref.update(observations, (all) => {
          const next = new Map(all)
          if (failure === undefined) next.delete(subscription)
          else next.set(subscription, failure)
          return next
        })
    })
  )
}))
