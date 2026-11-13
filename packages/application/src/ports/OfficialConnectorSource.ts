import { Context, Schema } from "effect"
import type { Effect } from "effect"
import { Ids } from "@exangelos/domain"

export const Official = Schema.Struct({
  name: Ids.ConnectorName,
  version: Schema.NonEmptyString,
  digest: Schema.String
})
export type Official = typeof Official.Type

export class OfficialFetchFailed extends Schema.TaggedError<OfficialFetchFailed>()("OfficialFetchFailed", {
  connector: Ids.ConnectorName,
  reason: Schema.String
}) {}

export class OfficialConnectorSource extends Context.Service<OfficialConnectorSource, {
  /**
   * The official connectors built with this binary. Each digest is the sha256 of the connector's files as
   * ConnectorDirectory.read computes it, so it also catches files changed after the fetch.
   */
  readonly known: ReadonlyArray<Official>
  /**
   * Downloads the connector's archive from the release files, or copies it from the local folder the
   * settings name, unpacks it into the connector directory and returns its directory. It does not
   * check the digest.
   */
  readonly fetch: (official: Official) => Effect.Effect<string, OfficialFetchFailed>
}>()("@exangelos/application/OfficialConnectorSource") {}
