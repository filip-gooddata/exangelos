import * as Fs from "node:fs/promises"
import * as Path from "node:path"
import * as Url from "node:url"
import { Cause, Effect, Layer } from "effect"
import { OfficialConnectorSource, ConnectorImportSource, SettingsStore } from "@exangelos/application"
import { NamedImport } from "@exangelos/connector-import"
import { Redact } from "@exangelos/logging"

/** The release file of an official connector: a gzip tar with `connector.json` at its root. */
const safeUrl = (link: string) => {
  const url = URL.canParse(link) ? new URL(link) : undefined
  return url !== undefined && (url.protocol === "https:" || url.protocol === "http:") ? url.origin + url.pathname : "[url]"
}

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

      const failedAt = (stage: string) => <A, R>(effect: Effect.Effect<A, string, R>) =>
        Effect.tapError(effect, (reason) =>
          Effect.logWarning(
            "official connector fetch failed",
            Cause.fail(`OfficialFetchFailed at ${stage}: ${Redact.sanitise(reason)}`)
          ).pipe(
            Effect.annotateLogs({ event: stage })
          ))

      const failedFor = (official: OfficialConnectorSource.Official) => (reason: string) =>
        new OfficialConnectorSource.OfficialFetchFailed({ connector: official.name, reason })

      const fetchWith = <A>(
        official: OfficialConnectorSource.Official,
        bring: (from: ConnectorImportSource.Source) => Effect.Effect<A, ConnectorImportSource.ImportFailed>
      ) =>
        Effect.gen(function*() {
          const current = yield* Effect.mapError(settings.read, (unreadable) => unreadable.reason).pipe(failedAt("settings"))
          const from = yield* source(official, current.officialConnectorFolder).pipe(failedAt("source"))
          yield* Effect.logInfo("official connector source chosen").pipe(
            Effect.annotateLogs({ source: from._tag, target: "path" in from ? from.path : safeUrl(from.url) })
          )
          const placed = yield* Effect.mapError(bring(from), (failed) => failed.reason).pipe(failedAt("import"))
          yield* Effect.logInfo("official connector fetched")
          return placed
        }).pipe(
          Effect.mapError(failedFor(official)),
          Effect.annotateLogs({ connector: official.name, version: official.version })
        )

      const fetch = (official: OfficialConnectorSource.Official) =>
        fetchWith(official, (from) => imports.place(from, official.name))

      const replace = (official: OfficialConnectorSource.Official) =>
        fetchWith(official, (from) => imports.replace(from, official.name, official.digest))

      const restore = (official: OfficialConnectorSource.Official) =>
        Effect.mapError(imports.restore(official.name), (failed) => failedFor(official)(failed.reason))

      const discard = (official: OfficialConnectorSource.Official) => imports.discard(official.name)

      const kept = (official: OfficialConnectorSource.Official) => imports.kept(official.name)

      return { known: options.known, fetch, replace, restore, discard, kept }
    })
  )
