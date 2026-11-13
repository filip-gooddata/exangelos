import * as Fs from "node:fs/promises"
import * as Path from "node:path"
import * as Url from "node:url"
import { Effect, Layer } from "effect"
import { OfficialPluginSource, PluginImportSource, SettingsStore } from "@exangelos/application"
import { NamedImport } from "@exangelos/plugin-import"

/** The release file of an official plugin: a gzip tar with `plugin.json` at its root. */
export const archiveName = (official: OfficialPluginSource.Official) => `${official.name}-${official.version}.tar.gz`

/**
 * Official plugins from the local folder the `officialPluginFolder` setting names, or else from the
 * release files under `releaseUrl`. Either way the archive goes through the import port, so it gets
 * the same checks as any other archive. A `file://` release address reads the release files from
 * that folder. A binary built without a release address fetches only from the setting's folder.
 */
export const layer = (options: {
  readonly known: ReadonlyArray<OfficialPluginSource.Official>
  readonly releaseUrl: string | undefined
}) =>
  Layer.effect(
    OfficialPluginSource.OfficialPluginSource,
    Effect.gen(function*() {
      const settings = yield* SettingsStore.SettingsStore
      const imports = yield* NamedImport

      const inFolder = (folder: string, file: string) => {
        const path = Path.join(folder, file)
        return Effect.tryPromise({
          try: () => Fs.access(path),
          catch: () => `${file} is not in ${folder}`
        }).pipe(Effect.as<PluginImportSource.Source>({ _tag: "ArchiveFile", path }))
      }

      const source = (official: OfficialPluginSource.Official, folder: string | undefined) => {
        const file = archiveName(official)
        const releaseUrl = options.releaseUrl
        if (folder !== undefined) return inFolder(folder, file)
        if (releaseUrl === undefined) {
          return Effect.fail(`this binary names no release address; point the officialPluginFolder setting at a folder holding ${file}`)
        }
        if (releaseUrl.startsWith("file:")) {
          return Effect.try({
            try: () => Url.fileURLToPath(releaseUrl),
            catch: () => `the release address ${releaseUrl} is not a usable file URL`
          }).pipe(Effect.flatMap((released) => inFolder(released, file)))
        }
        return Effect.succeed<PluginImportSource.Source>({ _tag: "HttpsLink", url: `${releaseUrl.replace(/\/$/, "")}/${file}` })
      }

      const fetch = (official: OfficialPluginSource.Official) =>
        Effect.gen(function*() {
          const current = yield* Effect.mapError(settings.read, (unreadable) => unreadable.reason)
          const from = yield* source(official, current.officialPluginFolder)
          return yield* Effect.mapError(imports.place(from, official.name), (failed) => failed.reason)
        }).pipe(Effect.mapError((reason) => new OfficialPluginSource.OfficialFetchFailed({ plugin: official.name, reason })))

      return { known: options.known, fetch }
    })
  )
