import { Context, Schema } from "effect"
import type { Effect } from "effect"
import { Catalogue, Ids } from "@exangelos/domain"

export class SecretStoreFailed extends Schema.TaggedError<SecretStoreFailed>()("SecretStoreFailed", {
  plugin: Ids.PluginName,
  reason: Schema.String
}) {}

export class SecretStore extends Context.Service<SecretStore, {
  /** The plugin's secret fields by key; empty when none are stored. */
  readonly read: (plugin: Ids.PluginName) => Effect.Effect<Catalogue.ConfigurationValues, SecretStoreFailed>
  /** Replaces every secret field of the plugin. */
  readonly write: (
    plugin: Ids.PluginName,
    secrets: Catalogue.ConfigurationValues
  ) => Effect.Effect<void, SecretStoreFailed>
  readonly clear: (plugin: Ids.PluginName) => Effect.Effect<void, SecretStoreFailed>
}>()("@exangelos/application/SecretStore") {}
