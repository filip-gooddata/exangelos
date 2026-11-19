import * as Fs from "node:fs/promises"
import * as Path from "node:path"
import * as Url from "node:url"
import { Cause, Effect, Layer } from "effect"
import { OfficialConnectorSource, ConnectorImportSource, SettingsStore } from "@exangelos/application"
import { NamedImport } from "@exangelos/connector-import"

/** The release file of an official connector: a gzip tar with `connector.json` at its root. */
const safeUrls = (text: string) =>
  text.replace(/\bhttps?:\S+/gi, (link) => URL.canParse(link) ? new URL(link).origin + new URL(link).pathname : "[url]")

export const archiveName = (official: OfficialConnectorSource.Official) => `${official.name}-${official.version}.tar.gz`

/**
 * Official connectors from the local folder the `officialConnectorFolder` setting names, or else from the
 * release files under `releaseUrl`. Either way the archive goes through the import port, so it gets
 * the same checks as any other archive. A `file://` release address reads the release files from
 * that folder. A binary built without a release address fetches only from the setting's folder.
 */
export const layer = (options: {
  readonly known: ReadonlyArray<OfficialConnectorSource.Official>
  readonly releaseUrl: string | undefined
}) =>
  Layer.effect(
    OfficialConnectorSource.OfficialConnectorSource,
    Effect.gen(function*() {
      const settings = yield* SettingsStore.SettingsStore
      const imports = yield* NamedImport

      const inFolder = (folder: string, file: string) => {
        const path = Path.join(folder, file)
        return Effect.tryPromise({
          try: () => Fs.access(path),
          catch: () => `${file} is not in ${folder}`
        }).pipe(Effect.as<ConnectorImportSource.Source>({ _tag: "ArchiveFile", path }))
      }

      const source = (official: OfficialConnectorSource.Official, folder: string | undefined) => {
        const file = archiveName(official)
        const releaseUrl = options.releaseUrl
        if (folder !== undefined) return inFolder(folder, file)
        if (releaseUrl === undefined) {
          return Effect.fail(`this binary names no release address; point the officialConnectorFolder setting at a folder holding ${file}`)
        }
        if (releaseUrl.startsWith("file:")) {
          return Effect.try({
            try: () => Url.fileURLToPath(releaseUrl),
            catch: () => `the release address ${releaseUrl} is not a usable file URL`
          }).pipe(Effect.flatMap((released) => inFolder(released, file)))
        }
        return Effect.succeed<ConnectorImportSource.Source>({ _tag: "HttpsLink", url: `${releaseUrl.replace(/\/$/, "")}/${file}` })
      }

      const fetch = (official: OfficialConnectorSource.Official) =>
        Effect.gen(function*() {
          const current = yield* Effect.mapError(settings.read, (unreadable) => unreadable.reason)
          const from = yield* source(official, current.officialConnectorFolder)
          yield* Effect.logInfo("official connector source chosen").pipe(
            Effect.annotateLogs({ source: from._tag, target: "path" in from ? from.path : safeUrls(from.url) })
          )
          const placed = yield* Effect.mapError(imports.place(from, official.name), (failed) => failed.reason)
          yield* Effect.logInfo("official connector fetched")
          return placed
        }).pipe(
          Effect.tapError((reason) => Effect.logWarning("official connector fetch failed", Cause.fail(safeUrls(reason)))),
          Effect.mapError((reason) => new OfficialConnectorSource.OfficialFetchFailed({ connector: official.name, reason })),
          Effect.annotateLogs({ connector: official.name, version: official.version })
        )

      return { known: options.known, fetch }
    })
  )
