import { Context, Schema } from "effect"
import type { Effect } from "effect"
import { Ids } from "@exangelos/domain"

export const Official = Schema.Struct({
  name: Ids.PluginName,
  version: Schema.NonEmptyString,
  digest: Schema.String
})
export type Official = typeof Official.Type

export class OfficialFetchFailed extends Schema.TaggedError<OfficialFetchFailed>()("OfficialFetchFailed", {
  plugin: Ids.PluginName,
  reason: Schema.String
}) {}

export class OfficialPluginSource extends Context.Service<OfficialPluginSource, {
  /**
   * The official plugins built with this binary. Each digest is the sha256 of the plugin's files as
   * PluginDirectory.read computes it, so it also catches files changed after the fetch.
   */
  readonly known: ReadonlyArray<Official>
  /**
   * Downloads the plugin's archive from the release files, or copies it from the local folder the
   * settings name, unpacks it into the plugin directory and returns its directory. It does not
   * check the digest.
   */
  readonly fetch: (official: Official) => Effect.Effect<string, OfficialFetchFailed>
}>()("@exangelos/application/OfficialPluginSource") {}
