import { Context, Schema } from "effect"
import type { Effect, Option, Redacted } from "effect"
import { Ids } from "@exangelos/domain"

export class SecretStoreFailed extends Schema.TaggedError<SecretStoreFailed>()("SecretStoreFailed", {
  connector: Ids.ConnectorName,
  reason: Schema.String
}) {}

export class SecretStore extends Context.Service<SecretStore, {
  readonly set: (
    connector: Ids.ConnectorName,
    field: string,
    value: Redacted.Redacted<string>
  ) => Effect.Effect<void, SecretStoreFailed>
  readonly get: (
    connector: Ids.ConnectorName,
    field: string
  ) => Effect.Effect<Option.Option<Redacted.Redacted<string>>, SecretStoreFailed>
  /**
   * Deletes the named fields; a field with no entry is skipped. Pass the catalogue's secret
   * fields, since a backend cannot list a connector's entries.
   */
  readonly delete: (connector: Ids.ConnectorName, fields: ReadonlyArray<string>) => Effect.Effect<void, SecretStoreFailed>
}>()("@exangelos/application/SecretStore") {}
