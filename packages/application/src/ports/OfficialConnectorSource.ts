import { Context, Schema } from "effect"
import type { Effect, Option } from "effect"
import { Ids } from "@exangelos/domain"

export const Official = Schema.Struct({
  name: Ids.ConnectorName,
  version: Schema.NonEmptyString,
  digest: Schema.String
})
export type Official = typeof Official.Type

/** What an official record said was installed before a replace, kept with it so a rollback can be finished later. */
export const Earlier = Schema.Struct({ version: Schema.String, digest: Schema.String })
export type Earlier = typeof Earlier.Type

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
  /**
   * Fetches the connector like `fetch`, but moves it over the installed copy only when its digest is the
   * one the binary carries. It keeps the earlier copy, and `earlier`, until `discard`, and refuses while
   * an earlier replace is not discarded. A failure leaves the installed copy as it was.
   */
  readonly replace: (official: Official, earlier: Earlier) => Effect.Effect<string, OfficialFetchFailed>
  /** Puts back the copy `replace` kept, or removes the new one when none was installed; repeating it does nothing. */
  readonly restore: (official: Official) => Effect.Effect<void, OfficialFetchFailed>
  /** Deletes the copy and the `earlier` that `replace` kept. */
  readonly discard: (official: Official) => Effect.Effect<void>
  /** The `earlier` of a replace not yet discarded. */
  readonly kept: (official: Official) => Effect.Effect<Option.Option<Earlier>, OfficialFetchFailed>
}>()("@exangelos/application/OfficialConnectorSource") {}
