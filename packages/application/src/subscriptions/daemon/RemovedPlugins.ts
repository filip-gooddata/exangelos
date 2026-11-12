import { Context, Effect, Layer, Option, Ref } from "effect"
import type { DateTime } from "effect"
import type { Ids } from "@exangelos/domain"

export interface Unavailable {
  readonly since: DateTime.Utc
  readonly problem: string
}

/**
 * Why each removed plugin is unavailable, kept in memory: a removed plugin has no record to read
 * it from, and its suspended wakes need it to be sent. `pluginRemoved` fills it again after a restart.
 */
export class RemovedPlugins extends Context.Service<RemovedPlugins, {
  readonly record: (plugin: Ids.PluginName, unavailable: Unavailable) => Effect.Effect<void>
  readonly forget: (plugin: Ids.PluginName) => Effect.Effect<void>
  readonly find: (plugin: Ids.PluginName) => Effect.Effect<Option.Option<Unavailable>>
}>()("@exangelos/application/RemovedPlugins") {}

export const layerRemovedPlugins: Layer.Layer<RemovedPlugins> = Layer.effect(
  RemovedPlugins,
  Effect.map(Ref.make<ReadonlyMap<Ids.PluginName, Unavailable>>(new Map()), (removed) => ({
    record: (plugin, unavailable) => Ref.update(removed, (all) => new Map(all).set(plugin, unavailable)),
    forget: (plugin) =>
      Ref.update(removed, (all) => {
        const rest = new Map(all)
        rest.delete(plugin)
        return rest
      }),
    find: (plugin) => Effect.map(Ref.get(removed), (all) => Option.fromUndefinedOr(all.get(plugin)))
  }))
)
