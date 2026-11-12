import { Context } from "effect"
import type { Effect, Option } from "effect"
import type { Catalogue, Ids, Plugin } from "@exangelos/domain"

export class PluginRepository extends Context.Service<PluginRepository, {
  readonly find: (name: Ids.PluginName) => Effect.Effect<Option.Option<Plugin.Plugin>>
  /** Ordered by name. */
  readonly list: Effect.Effect<ReadonlyArray<Plugin.Plugin>>
  readonly store: (plugin: Plugin.Plugin) => Effect.Effect<void>
  /** Removes the plugin record and its stored configuration values. */
  readonly remove: (name: Ids.PluginName) => Effect.Effect<void>
  /** The plugin's non-secret configuration values; empty when none are stored. */
  readonly values: (name: Ids.PluginName) => Effect.Effect<Catalogue.ConfigurationValues>
  /** Replaces the plugin's non-secret configuration values. Secret fields belong in the SecretStore. */
  readonly storeValues: (name: Ids.PluginName, values: Catalogue.ConfigurationValues) => Effect.Effect<void>
}>()("@exangelos/application/PluginRepository") {}
