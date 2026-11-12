import { Context, Effect, Layer, Ref } from "effect"
import type { Catalogue, Ids } from "@exangelos/domain"
import type { OfficialFetchFailed } from "../ports/OfficialPluginSource.ts"
import {
  PluginAccess,
  PluginNotFound,
  type Described,
  type ParametersInvalid,
  type PluginUnavailable
} from "../seam/PluginAccess.ts"

export type Describe = (
  parameters: Catalogue.Parameters
) => Effect.Effect<Described, PluginUnavailable | OfficialFetchFailed | ParametersInvalid>

export class PluginAccessFake extends Context.Service<PluginAccessFake, {
  /** How `describe` answers for the plugin; an unknown plugin is not found. */
  readonly define: (plugin: Ids.PluginName, describe: Describe) => Effect.Effect<void>
  /** Subscriptions currently watched, in the order `watch` was first called. */
  readonly watched: Effect.Effect<ReadonlyArray<Ids.SubscriptionId>>
}>()("@exangelos/application/testing/PluginAccessFake") {}

export const layerPluginAccess: Layer.Layer<PluginAccess | PluginAccessFake> = Layer.unwrap(Effect.gen(function*() {
  const plugins = yield* Ref.make<ReadonlyMap<Ids.PluginName, Describe>>(new Map())
  const watched = yield* Ref.make<ReadonlyArray<Ids.SubscriptionId>>([])
  return Layer.merge(
    Layer.succeed(PluginAccess, {
      describe: (plugin, parameters) =>
        Effect.gen(function*() {
          const describe = (yield* Ref.get(plugins)).get(plugin)
          if (describe === undefined) {
            return yield* new PluginNotFound({ plugin })
          }
          return yield* describe(parameters)
        }),
      watch: (subscription) =>
        Ref.update(watched, (all) => all.includes(subscription) ? all : [...all, subscription]),
      unwatch: (subscription) => Ref.update(watched, (all) => all.filter((id) => id !== subscription))
    }),
    Layer.succeed(PluginAccessFake, {
      define: (plugin, describe) => Ref.update(plugins, (all) => new Map(all).set(plugin, describe)),
      watched: Ref.get(watched)
    })
  )
}))
