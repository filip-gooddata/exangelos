import { Context, Schema } from "effect"
import type { Effect, Option } from "effect"
import { Catalogue, Ids, Plugin, Session } from "@exangelos/domain"

export const PluginChangeKind = Schema.Literals([
  "import",
  "fetch",
  "enable",
  "disable",
  "remove",
  "configure",
  "dev-link",
  "dev-unlink"
])
export type PluginChangeKind = typeof PluginChangeKind.Type

export const PluginChange = Schema.Struct({
  plugin: Ids.PluginName,
  kind: PluginChangeKind,
  actor: Session.Actor,
  at: Schema.DateTimeUtc,
  detail: Schema.optionalKey(Schema.String)
})
export type PluginChange = typeof PluginChange.Type

export class PluginRepository extends Context.Service<PluginRepository, {
  readonly find: (name: Ids.PluginName) => Effect.Effect<Option.Option<Plugin.Plugin>>
  /** Ordered by name. */
  readonly list: Effect.Effect<ReadonlyArray<Plugin.Plugin>>
  /** Inserts or replaces the plugin and appends the change, if any, in one write. */
  readonly store: (plugin: Plugin.Plugin, change?: PluginChange) => Effect.Effect<void>
  /** Removes the plugin record and its configuration values and appends the change. Its changes stay. */
  readonly remove: (name: Ids.PluginName, change: PluginChange) => Effect.Effect<void>
  /** Oldest first, including changes from before a removal. */
  readonly changes: (name: Ids.PluginName) => Effect.Effect<ReadonlyArray<PluginChange>>
  /** The plugin's non-secret configuration values; empty when none are stored. */
  readonly values: (name: Ids.PluginName) => Effect.Effect<Catalogue.ConfigurationValues>
  /** Replaces the plugin's non-secret configuration values. Secret fields belong in the SecretStore. */
  readonly storeValues: (name: Ids.PluginName, values: Catalogue.ConfigurationValues) => Effect.Effect<void>
}>()("@exangelos/application/PluginRepository") {}
