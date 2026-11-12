import { Context, Effect, Layer, Ref } from "effect"
import { Subscribe } from "@exangelos/domain"
import type { Catalogue, Ids, Refusal } from "@exangelos/domain"
import type { OfficialFetchFailed } from "../ports/OfficialPluginSource.ts"
import { PluginAccess, PluginNotFound, type Described } from "../seam/PluginAccess.ts"

/** Answers for parameters that already carry the main parameter. */
export type Describe = (
  parameters: Catalogue.Parameters
) => Effect.Effect<Described, Refusal.PluginUnavailable | Refusal.ParametersInvalid | OfficialFetchFailed>

interface Defined {
  readonly catalogue: Catalogue.Catalogue
  readonly describe: Describe
}

export class PluginAccessFake extends Context.Service<PluginAccessFake, {
  /**
   * How `describe` answers for the plugin, after joining `main` under the catalogue's main
   * parameter; an unknown plugin is not found.
   */
  readonly define: (plugin: Ids.PluginName, catalogue: Catalogue.Catalogue, describe: Describe) => Effect.Effect<void>
  /** Subscriptions currently watched, in the order `watch` was first called. */
  readonly watched: Effect.Effect<ReadonlyArray<Ids.SubscriptionId>>
}>()("@exangelos/application/testing/PluginAccessFake") {}

export const layerPluginAccess: Layer.Layer<PluginAccess | PluginAccessFake> = Layer.unwrap(Effect.gen(function*() {
  const plugins = yield* Ref.make<ReadonlyMap<Ids.PluginName, Defined>>(new Map())
  const watched = yield* Ref.make<ReadonlyArray<Ids.SubscriptionId>>([])
  return Layer.merge(
    Layer.succeed(PluginAccess, {
      describe: (_actor, plugin, { main, parameters }) =>
        Effect.gen(function*() {
          const defined = (yield* Ref.get(plugins)).get(plugin)
          if (defined === undefined) {
            return yield* new PluginNotFound({ plugin })
          }
          const joined = yield* Effect.fromResult(Subscribe.withMain(parameters, defined.catalogue.parameters.main, main))
          return yield* defined.describe(joined)
        }),
      watch: (subscription) =>
        Ref.update(watched, (all) => all.includes(subscription) ? all : [...all, subscription]),
      unwatch: (subscription) => Ref.update(watched, (all) => all.filter((id) => id !== subscription))
    }),
    Layer.succeed(PluginAccessFake, {
      define: (plugin, catalogue, describe) => Ref.update(plugins, (all) => new Map(all).set(plugin, { catalogue, describe })),
      watched: Ref.get(watched)
    })
  )
}))
