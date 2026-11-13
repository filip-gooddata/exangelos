import { Context, Schema } from "effect"
import type { Effect, Option } from "effect"
import { Catalogue, Ids, Connector, Session } from "@exangelos/domain"

export const ConnectorChangeKind = Schema.Literals([
  "import",
  "fetch",
  "enable",
  "disable",
  "remove",
  "configure",
  "dev-link",
  "dev-unlink"
])
export type ConnectorChangeKind = typeof ConnectorChangeKind.Type

export const ConnectorChange = Schema.Struct({
  connector: Ids.ConnectorName,
  kind: ConnectorChangeKind,
  actor: Session.Actor,
  at: Schema.DateTimeUtc,
  detail: Schema.optionalKey(Schema.String)
})
export type ConnectorChange = typeof ConnectorChange.Type

export class ConnectorRepository extends Context.Service<ConnectorRepository, {
  readonly find: (name: Ids.ConnectorName) => Effect.Effect<Option.Option<Connector.Connector>>
  /** Ordered by name. */
  readonly list: Effect.Effect<ReadonlyArray<Connector.Connector>>
  /** Inserts or replaces the connector and appends the change, if any, in one write. */
  readonly store: (connector: Connector.Connector, change?: ConnectorChange) => Effect.Effect<void>
  /** Removes the connector record and its configuration values and appends the change. Its changes stay. */
  readonly remove: (name: Ids.ConnectorName, change: ConnectorChange) => Effect.Effect<void>
  /** Oldest first, including changes from before a removal. */
  readonly changes: (name: Ids.ConnectorName) => Effect.Effect<ReadonlyArray<ConnectorChange>>
  /** The connector's non-secret configuration values; empty when none are stored. */
  readonly values: (name: Ids.ConnectorName) => Effect.Effect<Catalogue.ConfigurationValues>
  /** Replaces the connector's non-secret configuration values. Secret fields belong in the SecretStore. */
  readonly storeValues: (name: Ids.ConnectorName, values: Catalogue.ConfigurationValues) => Effect.Effect<void>
}>()("@exangelos/application/ConnectorRepository") {}
