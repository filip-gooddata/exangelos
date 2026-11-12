import { Context, Effect, Layer, PubSub, Ref, Stream } from "effect"
import type { Ids } from "@exangelos/domain"
import { OfficialFetchFailed, OfficialPluginSource, type Official } from "../ports/OfficialPluginSource.ts"
import { ManifestInvalid, PluginDirectory, type Installed } from "../ports/PluginDirectory.ts"
import { ImportFailed, PluginImportSource, type Source } from "../ports/PluginImportSource.ts"

export const pluginRoot = "/plugins"

const inRoot = (plugin: Installed): Installed => ({ ...plugin, directory: `${pluginRoot}/${plugin.name}` })

interface Files {
  readonly directories: ReadonlyMap<string, Installed>
  readonly sources: ReadonlyMap<string, Installed>
  readonly releases: ReadonlyMap<Ids.PluginName, Installed>
}

export class PluginFilesFake extends Context.Service<PluginFilesFake, {
  /** Puts plugin files at `plugin.directory`, as a dev link sees them; under `pluginRoot` they are listed. */
  readonly put: (plugin: Installed) => Effect.Effect<void>
  /** Importing the source will place the plugin in the plugin directory. */
  readonly offer: (source: Source, plugin: Installed) => Effect.Effect<void>
  /** The official source will serve the plugin; a digest unlike the known one stands for a tampered archive. */
  readonly publish: (plugin: Installed) => Effect.Effect<void>
  /** Changes the files in the directory: they get the digest, and `changes` emits for the directory. */
  readonly edit: (directory: string, digest: string) => Effect.Effect<void>
}>()("@exangelos/application/testing/PluginFilesFake") {}

/**
 * PluginDirectory, PluginImportSource and OfficialPluginSource over one in-memory file tree, so a
 * placed or fetched plugin is then listed and read. Official plugins not yet published fail to fetch.
 */
export const layerPluginFiles = (known: ReadonlyArray<Official>): Layer.Layer<
  PluginDirectory | PluginImportSource | OfficialPluginSource | PluginFilesFake
> =>
  Layer.unwrap(Effect.gen(function*() {
    const files = yield* Ref.make<Files>({ directories: new Map(), sources: new Map(), releases: new Map() })
    const changed = yield* PubSub.unbounded<string>()
    const place = (plugin: Installed) =>
      Effect.as(Ref.update(files, (f) => ({ ...f, directories: new Map(f.directories).set(plugin.directory, plugin) })), plugin.directory)

    return Layer.mergeAll(
      Layer.succeed(PluginDirectory, {
        list: Effect.map(Ref.get(files), (f) =>
          [...f.directories.values()]
            .filter((plugin) => plugin.directory.startsWith(`${pluginRoot}/`))
            .sort((a, b) => a.name.localeCompare(b.name))),
        read: (directory) =>
          Effect.flatMap(Ref.get(files), (f) => {
            const plugin = f.directories.get(directory)
            return plugin === undefined
              ? Effect.fail(new ManifestInvalid({ directory, reason: "no manifest" }))
              : Effect.succeed(plugin)
          }),
        remove: (name) =>
          Ref.update(files, (f) => {
            const directories = new Map(f.directories)
            directories.delete(`${pluginRoot}/${name}`)
            return { ...f, directories }
          }),
        changes: (directory) =>
          Stream.fromPubSub(changed).pipe(
            Stream.filter((path) => path === directory),
            Stream.map(() => undefined)
          )
      }),
      Layer.succeed(PluginImportSource, {
        place: (source) =>
          Effect.flatMap(Ref.get(files), (f) => {
            const plugin = f.sources.get(JSON.stringify(source))
            return plugin === undefined
              ? Effect.fail(new ImportFailed({ reason: `nothing to import at ${JSON.stringify(source)}` }))
              : place(inRoot(plugin))
          })
      }),
      Layer.succeed(OfficialPluginSource, {
        known,
        fetch: (official) =>
          Effect.flatMap(Ref.get(files), (f) => {
            const plugin = f.releases.get(official.name)
            return plugin === undefined
              ? Effect.fail(new OfficialFetchFailed({ plugin: official.name, reason: "offline" }))
              : place(inRoot(plugin))
          })
      }),
      Layer.succeed(PluginFilesFake, {
        put: (plugin) => Effect.asVoid(place(plugin)),
        offer: (source, plugin) =>
          Ref.update(files, (f) => ({ ...f, sources: new Map(f.sources).set(JSON.stringify(source), plugin) })),
        publish: (plugin) =>
          Ref.update(files, (f) => ({ ...f, releases: new Map(f.releases).set(plugin.name, plugin) })),
        edit: (directory, digest) =>
          Effect.andThen(
            Ref.update(files, (f) => {
              const plugin = f.directories.get(directory)
              return plugin === undefined
                ? f
                : { ...f, directories: new Map(f.directories).set(directory, { ...plugin, digest }) }
            }),
            PubSub.publish(changed, directory)
          )
      })
    )
  }))
