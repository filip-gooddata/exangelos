import { Context, Schema } from "effect"
import type { Effect, Option, Stream } from "effect"
import { type Connector, Ids } from "@exangelos/domain"
import { Entry } from "./ConnectorRuntime.ts"

export const Installed = Schema.Struct({
  name: Ids.ConnectorName,
  version: Schema.NonEmptyString,
  directory: Schema.String,
  entry: Entry,
  digest: Schema.String
})
export type Installed = typeof Installed.Type

export class ManifestInvalid extends Schema.TaggedError<ManifestInvalid>()("ManifestInvalid", {
  directory: Schema.String,
  reason: Schema.String
}) {}

export class ConnectorDirectoryFailed extends Schema.TaggedError<ConnectorDirectoryFailed>()("ConnectorDirectoryFailed", {
  reason: Schema.String
}) {}

export class ConnectorDirectory extends Context.Service<ConnectorDirectory, {
  /** Connectors in the connector directory whose manifest reads, by name. */
  readonly list: Effect.Effect<ReadonlyArray<Installed>, ConnectorDirectoryFailed>
  /**
   * Reads the manifest of a connector in any directory, such as a dev link, resolves its entry for
   * this platform and computes the sha256 digest of its files.
   */
  readonly read: (directory: string) => Effect.Effect<Installed, ManifestInvalid>
  /**
   * The logo the manifest names for the connector in the connector directory, or in `directory` when given,
   * such as a dev link. A missing or refused icon is none; a refused one is logged.
   */
  readonly icon: (name: Ids.ConnectorName, directory?: string) => Effect.Effect<Option.Option<Connector.Icon>>
  /** Deletes the connector's files from the connector directory. */
  readonly remove: (name: Ids.ConnectorName) => Effect.Effect<void, ConnectorDirectoryFailed>
  /** Emits once for each settled change to the files under the directory. */
  readonly changes: (directory: string) => Stream.Stream<void, ConnectorDirectoryFailed>
}>()("@exangelos/application/ConnectorDirectory") {}
