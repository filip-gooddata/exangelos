import * as Fs from "node:fs/promises"
import * as Path from "node:path"
import { Duration, Effect, FileSystem, Layer, Schema, Stream } from "effect"
import { PluginDirectory } from "@exangelos/application"
import { Manifest } from "@exangelos/contracts"
import { Paths } from "@exangelos/paths"
import { digestDirectory } from "./Digest.ts"

const { ManifestInvalid, PluginDirectoryFailed } = PluginDirectory

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
  if (path === undefined) return Effect.fail(`the entry ${relative} is outside the plugin`)
  return Effect.tryPromise({
    try: () => Fs.lstat(path),
    catch: () => `the entry ${relative} does not exist`
  }).pipe(
    Effect.filterOrFail((stat) => stat.isFile(), () => `the entry ${relative} is not a file`),
    Effect.as({ _tag: entry._tag, path } as const)
  )
}

/**
 * Reads `plugin.json` in the directory, resolves the entry for this platform to an absolute path
 * inside the directory and computes the digest of the files.
 */
export const readPlugin = (directory: string): Effect.Effect<PluginDirectory.Installed, PluginDirectory.ManifestInvalid> =>
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
 * The plugin directory at `Paths.pluginDir`: one subdirectory per plugin, named after the plugin. A subdirectory whose
 * manifest does not read, or names another plugin, is left out of `list`.
 */
export const layer = Layer.effect(
    PluginDirectory.PluginDirectory,
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const root = Path.resolve((yield* Paths.Paths).pluginDir)

      const list = Effect.gen(function*() {
        const entries = yield* Effect.tryPromise({
          try: () => Fs.readdir(root, { withFileTypes: true }),
          catch: (cause) => new PluginDirectoryFailed({ reason: message(cause) })
        }).pipe(Effect.catchIf(
          (failed) => failed.reason.includes("ENOENT"),
          () => Effect.succeed([])
        ))
        const plugins = yield* Effect.forEach(
          entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith(".")),
          (entry) =>
            readPlugin(Path.join(root, entry.name)).pipe(
              Effect.flatMap((plugin) =>
                plugin.name === entry.name
                  ? Effect.succeed([plugin])
                  : Effect.fail(new ManifestInvalid({ directory: plugin.directory, reason: `the manifest names ${plugin.name}` }))
              ),
              Effect.catchTag("ManifestInvalid", (invalid) =>
                Effect.as(Effect.logWarning(`Skipping ${invalid.directory}: ${invalid.reason}`), []))
            )
        )
        return plugins.flat().sort((a, b) => a.name.localeCompare(b.name))
      })

      const remove = (name: string) =>
        Path.basename(name) === name && name !== "." && name !== ".."
          ? Effect.tryPromise({
            try: () => Fs.rm(Path.join(root, name), { recursive: true, force: true }),
            catch: (cause) => new PluginDirectoryFailed({ reason: message(cause) })
          })
          : Effect.fail(new PluginDirectoryFailed({ reason: `${name} is not a plugin name` }))

      const changes = (directory: string) =>
        fs.watch(directory, { recursive: true }).pipe(
          Stream.debounce(settleTime),
          Stream.map(() => undefined),
          Stream.mapError((error) => new PluginDirectoryFailed({ reason: error.message }))
        )

      return { list, read: readPlugin, remove, changes }
    })
)
