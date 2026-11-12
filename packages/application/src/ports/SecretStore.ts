import { Context, Schema } from "effect"
import type { Effect, Option, Redacted } from "effect"
import { Ids } from "@exangelos/domain"

export class SecretStoreFailed extends Schema.TaggedError<SecretStoreFailed>()("SecretStoreFailed", {
  plugin: Ids.PluginName,
  reason: Schema.String
}) {}

export class SecretStore extends Context.Service<SecretStore, {
  readonly set: (
    plugin: Ids.PluginName,
    field: string,
    value: Redacted.Redacted<string>
  ) => Effect.Effect<void, SecretStoreFailed>
  readonly get: (
    plugin: Ids.PluginName,
    field: string
  ) => Effect.Effect<Option.Option<Redacted.Redacted<string>>, SecretStoreFailed>
  /**
   * Deletes the named fields; a field with no entry is skipped. Pass the catalogue's secret
   * fields, since a backend cannot list a plugin's entries.
   */
  readonly delete: (plugin: Ids.PluginName, fields: ReadonlyArray<string>) => Effect.Effect<void, SecretStoreFailed>
}>()("@exangelos/application/SecretStore") {}
