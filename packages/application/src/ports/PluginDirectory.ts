import { Context, Schema } from "effect"
import type { Effect, Stream } from "effect"
import { Ids } from "@exangelos/domain"
import { Entry } from "./PluginRuntime.ts"

export const Installed = Schema.Struct({
  name: Ids.PluginName,
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

export class PluginDirectoryFailed extends Schema.TaggedError<PluginDirectoryFailed>()("PluginDirectoryFailed", {
  reason: Schema.String
}) {}

export class PluginDirectory extends Context.Service<PluginDirectory, {
  /** Plugins in the plugin directory whose manifest reads, by name. */
  readonly list: Effect.Effect<ReadonlyArray<Installed>, PluginDirectoryFailed>
  /**
   * Reads the manifest of a plugin in any directory, such as a dev link, resolves its entry for
   * this platform and computes the sha256 digest of its files.
   */
  readonly read: (directory: string) => Effect.Effect<Installed, ManifestInvalid>
  /** Deletes the plugin's files from the plugin directory. */
  readonly remove: (name: Ids.PluginName) => Effect.Effect<void, PluginDirectoryFailed>
  /** Emits once for each settled change to the files under the directory. */
  readonly changes: (directory: string) => Stream.Stream<void, PluginDirectoryFailed>
}>()("@exangelos/application/PluginDirectory") {}
