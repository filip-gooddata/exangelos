import * as Fs from "node:fs/promises"
import * as Path from "node:path"
import { Duration, Effect, FileSystem, Layer, Option, Schema, Stream } from "effect"
import { ConnectorDirectory } from "@exangelos/application"
import { Manifest } from "@exangelos/contracts"
import type { Ids } from "@exangelos/domain"
import { Paths } from "@exangelos/paths"
import { digestDirectory } from "./Digest.ts"
import { readIcon } from "./Icon.ts"

const { ManifestInvalid, ConnectorDirectoryFailed } = ConnectorDirectory

/** How long the files must stay quiet before `changes` reports them as settled. */
export const settleTime = Duration.millis(300)

const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))

const platform = `${process.platform}-${process.arch}`

const insideDirectory = (directory: string, relative: string) => {
  const absolute = Path.resolve(directory, relative)
  return absolute.startsWith(directory + Path.sep) ? absolute : undefined
}

const resolveEntry = (directory: string, entry: Manifest.Entry) => {
  const relative = entry._tag === "Bundle"
    ? entry.path
    : (entry.paths as Partial<Record<string, string>>)[platform]
  if (relative === undefined) return Effect.fail(`the manifest has no native entry for ${platform}`)
  const path = insideDirectory(directory, relative)
  if (path === undefined) return Effect.fail(`the entry ${relative} is outside the connector`)
  return Effect.tryPromise({
    try: async () => {
      const [real, realDirectory] = await Promise.all([Fs.realpath(path), Fs.realpath(directory)])
      return { real, inside: real.startsWith(realDirectory + Path.sep), stat: await Fs.stat(real) }
    },
    catch: () => `the entry ${relative} does not exist`
  }).pipe(
    Effect.filterOrFail(({ inside }) => inside, () => `the entry ${relative} leads outside the connector`),
    Effect.filterOrFail(({ stat }) => stat.isFile(), () => `the entry ${relative} is not a file`),
    Effect.as({ _tag: entry._tag, path } as const)
  )
}

/**
 * Reads `connector.json` in the directory, resolves the entry for this platform to an absolute path
 * inside the directory and computes the digest of the files.
 */
export const readConnector = (directory: string): Effect.Effect<ConnectorDirectory.Installed, ConnectorDirectory.ManifestInvalid> =>
  Effect.gen(function*() {
    const absolute = Path.resolve(directory)
    const text = yield* Effect.tryPromise({
      try: () => Fs.readFile(Path.join(absolute, Manifest.fileName), "utf8"),
      catch: (cause) => `${Manifest.fileName} cannot be read: ${message(cause)}`
    })
    const json = yield* Effect.try({ try: () => JSON.parse(text) as unknown, catch: () => `${Manifest.fileName} is not JSON` })
    const manifest = yield* Schema.decodeUnknownEffect(Manifest.Manifest)(json).pipe(
      Effect.mapError((issue) => `${Manifest.fileName} is invalid: ${issue.message}`)
    )
    const entry = yield* resolveEntry(absolute, manifest.entry)
    const digest = yield* Effect.mapError(digestDirectory(absolute), (failed) => failed.reason)
    return { name: manifest.name, version: manifest.version, directory: absolute, entry, digest }
  }).pipe(Effect.mapError((reason) => new ManifestInvalid({ directory, reason })))

/**
 * The connector directory at `Paths.connectorDir`: one subdirectory per connector, named after the connector. A subdirectory whose
 * manifest does not read, or names another connector, is left out of `list`.
 */
export const layer = Layer.effect(
    ConnectorDirectory.ConnectorDirectory,
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const root = Path.resolve((yield* Paths.Paths).connectorDir)

      const list = Effect.gen(function*() {
        const entries = yield* Effect.tryPromise({
          try: () => Fs.readdir(root, { withFileTypes: true }),
          catch: (cause) => new ConnectorDirectoryFailed({ reason: message(cause) })
        }).pipe(Effect.catchIf(
          (failed) => failed.reason.includes("ENOENT"),
          () => Effect.succeed([])
        ))
        const connectors = yield* Effect.forEach(
          entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith(".")),
          (entry) =>
            readConnector(Path.join(root, entry.name)).pipe(
              Effect.flatMap((connector) =>
                connector.name === entry.name
                  ? Effect.succeed([connector])
                  : Effect.fail(new ManifestInvalid({ directory: connector.directory, reason: `the manifest names ${connector.name}` }))
              ),
              Effect.catchTag("ManifestInvalid", (invalid) =>
                Effect.as(Effect.logWarning(`Skipping ${invalid.directory}: ${invalid.reason}`), []))
            )
        )
        return connectors.flat().sort((a, b) => a.name.localeCompare(b.name))
      })

      const remove = (name: string) =>
        Path.basename(name) === name && name !== "." && name !== ".."
          ? Effect.tryPromise({
            try: () => Fs.rm(Path.join(root, name), { recursive: true, force: true }),
            catch: (cause) => new ConnectorDirectoryFailed({ reason: message(cause) })
          })
          : Effect.fail(new ConnectorDirectoryFailed({ reason: `${name} is not a connector name` }))

      const changes = (directory: string) =>
        fs.watch(directory, { recursive: true }).pipe(
          Stream.debounce(settleTime),
          Stream.map(() => undefined),
          Stream.mapError((error) => new ConnectorDirectoryFailed({ reason: error.message }))
        )

      const refused = new Map<string, string>()
      const icon = (name: Ids.ConnectorName, directory?: string) =>
        Effect.gen(function*() {
          const at = directory === undefined ? Path.join(root, name) : Path.resolve(directory)
          const manifest = yield* Effect.tryPromise(() => Fs.readFile(Path.join(at, Manifest.fileName), "utf8")).pipe(
            Effect.flatMap((text) => Effect.try(() => JSON.parse(text) as unknown)),
            Effect.flatMap(Schema.decodeUnknownEffect(Manifest.Manifest)),
            Effect.option
          )
          if (Option.isNone(manifest) || manifest.value.icon === undefined) return Option.none()
          const declared = manifest.value.icon
          return yield* (typeof declared === "string" ? readIcon(at, declared) : Effect.fail("the icon is not a path")).pipe(
            Effect.tap(() => Effect.sync(() => refused.delete(at))),
            Effect.asSome,
            Effect.catch((reason) => {
              // The panel lists connectors often; warn once per refusal rather than on every listing.
              if (refused.get(at) === reason) return Effect.succeedNone
              refused.set(at, reason)
              return Effect.as(Effect.logWarning(`Connector ${name} has no icon: ${reason}`), Option.none())
            })
          )
        })

      return { list, read: readConnector, remove, changes, icon }
    })
)
