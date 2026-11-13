import { Context, Schema } from "effect"
import type { Effect } from "effect"

export const Source = Schema.TaggedUnion({
  ArchiveFile: { path: Schema.String },
  HttpsLink: { url: Schema.String },
  Directory: { path: Schema.String },
  GitRepository: { url: Schema.String, ref: Schema.String }
})
export type Source = typeof Source.Type

export class ImportFailed extends Schema.TaggedError<ImportFailed>()("ImportFailed", {
  reason: Schema.String
}) {}

export class ConnectorImportSource extends Context.Service<ConnectorImportSource, {
  /**
   * Copies the connector from the source into the connector directory under its manifest name,
   * replacing an earlier copy, and returns its directory. Nothing in it runs. An archive entry
   * that would land outside the target directory fails the import.
   */
  readonly place: (source: Source) => Effect.Effect<string, ImportFailed>
}>()("@exangelos/application/ConnectorImportSource") {}
