import * as Fs from "node:fs/promises"
import * as Path from "node:path"
import { Effect, Layer } from "effect"
import { OfficialPluginSource, PluginImportSource, SettingsStore } from "@exangelos/application"

/** The release file of an official plugin: a gzip tar with `plugin.json` at its root. */
export const archiveName = (official: OfficialPluginSource.Official) => `${official.name}-${official.version}.tar.gz`

/**
 * Official plugins from the local folder the `officialPluginFolder` setting names, or else from the
 * release files under `releaseUrl`. Either way the archive goes through the import port, so it gets
 * the same checks as any other archive.
 */
export const layer = (options: {
  readonly known: ReadonlyArray<OfficialPluginSource.Official>
  readonly releaseUrl: string
}) =>
  Layer.effect(
    OfficialPluginSource.OfficialPluginSource,
    Effect.gen(function*() {
      const settings = yield* SettingsStore.SettingsStore
      const imports = yield* PluginImportSource.PluginImportSource

      const source = (official: OfficialPluginSource.Official, folder: string | undefined) => {
        const file = archiveName(official)
        if (folder === undefined) {
          return Effect.succeed<PluginImportSource.Source>({ _tag: "HttpsLink", url: `${options.releaseUrl.replace(/\/$/, "")}/${file}` })
        }
        const path = Path.join(folder, file)
        return Effect.tryPromise({
          try: () => Fs.access(path),
          catch: () => `${file} is not in ${folder}`
        }).pipe(Effect.as<PluginImportSource.Source>({ _tag: "ArchiveFile", path }))
      }

      const fetch = (official: OfficialPluginSource.Official) =>
        Effect.gen(function*() {
          const current = yield* Effect.mapError(settings.read, (unreadable) => unreadable.reason)
          const from = yield* source(official, current.officialPluginFolder)
          const directory = yield* Effect.mapError(imports.place(from), (failed) => failed.reason)
          if (Path.basename(directory) !== official.name) {
            return yield* Effect.fail(`the archive holds ${Path.basename(directory)}, not ${official.name}`)
          }
          return directory
        }).pipe(Effect.mapError((reason) => new OfficialPluginSource.OfficialFetchFailed({ plugin: official.name, reason })))

      return { known: options.known, fetch }
    })
  )
