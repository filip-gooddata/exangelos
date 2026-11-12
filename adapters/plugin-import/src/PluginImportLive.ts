import * as Fs from "node:fs/promises"
import * as Path from "node:path"
import { Context, Effect, Layer, Semaphore } from "effect"
import { PluginDirectory, PluginImportSource } from "@exangelos/application"
import { Paths } from "@exangelos/paths"
import { HttpClient } from "effect/http"
import { ChildProcessSpawner } from "effect/process"
import { unpack } from "./Archive.ts"
import { copyTree, inspectTree, limits, pluginRoot, Refused } from "./Entries.ts"
import { download } from "./Download.ts"
import { checkout } from "./Git.ts"

const reasonOf = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))

const attempt = <A>(f: () => Promise<A>) =>
  Effect.tryPromise({ try: f, catch: (cause) => (cause instanceof Refused ? cause : new Refused({ reason: reasonOf(cause) })) })

/**
 * Places an import only if its manifest names the expected plugin. The name is checked while the
 * import is staged, so a mismatch never touches an installed plugin. `layer` provides it beside the port.
 */
export class NamedImport extends Context.Service<NamedImport, {
  readonly place: (
    source: PluginImportSource.Source,
    name: string
  ) => Effect.Effect<string, PluginImportSource.ImportFailed>
}>()("@exangelos/plugin-import/NamedImport") {}

/**
 * Places plugins from archives, https links, local directories and git repositories into the
 * plugin directory at `Paths.pluginDir`. Each import is staged in a new directory beside the plugin directory, checked,
 * and only then moved under the plugin's manifest name. A failed import leaves the plugin directory
 * as it was.
 */
const make = Effect.gen(function*() {
      const plugins = yield* PluginDirectory.PluginDirectory
      const context = yield* Effect.context<ChildProcessSpawner.ChildProcessSpawner | HttpClient.HttpClient>()
      const root = Path.resolve((yield* Paths.Paths).pluginDir)
      const swap = yield* Semaphore.make(1)

      const stage = Effect.acquireRelease(
        attempt(async () => {
          await Fs.mkdir(root, { recursive: true })
          return Fs.mkdtemp(Path.join(Path.dirname(root), `.${Path.basename(root)}-import-`))
        }),
        (staging) => Effect.promise(() => Fs.rm(staging, { recursive: true, force: true }))
      )

      const bring = (source: PluginImportSource.Source, staging: string) => {
        const content = Path.join(staging, "content")
        switch (source._tag) {
          case "ArchiveFile":
            return attempt(async () => {
              const copy = Path.join(staging, "archive")
              const stat = await Fs.stat(source.path).catch(() => undefined)
              if (stat === undefined || !stat.isFile()) throw new Refused({ reason: `${source.path} is not a file` })
              if (stat.size > limits.downloadBytes) throw new Refused({ reason: `the archive is larger than ${limits.downloadBytes} bytes` })
              await Fs.copyFile(source.path, copy, Fs.constants.COPYFILE_EXCL)
              await unpack(copy, content)
            })
          case "HttpsLink": {
            const file = Path.join(staging, "archive")
            return download(source.url, file).pipe(Effect.andThen(attempt(() => unpack(file, content))))
          }
          case "Directory":
            return attempt(() => copyTree(Path.resolve(source.path), content))
          case "GitRepository": {
            const home = Path.join(staging, "home")
            return attempt(() => Fs.mkdir(home)).pipe(
              Effect.andThen(checkout(source.url, source.ref, content, home)),
              Effect.andThen(attempt(() => Fs.rm(Path.join(content, ".git"), { recursive: true, force: true })))
            )
          }
        }
      }

      const moveIntoPlace = (directory: string, name: string, staging: string) =>
        attempt(async () => {
          const target = Path.join(root, name)
          const previous = Path.join(root, `.${name}.previous-${Path.basename(staging)}`)
          const replaced = await Fs.rename(target, previous).then(() => true, () => false)
          try {
            await Fs.rename(directory, target)
          } catch (error) {
            if (replaced) {
              await Fs.rename(previous, target).catch(() => {
                throw new Refused({ reason: `${reasonOf(error)}; the earlier copy is kept at ${previous}` })
              })
            }
            throw error
          }
          if (replaced) await Fs.rm(previous, { recursive: true, force: true })
          return target
        })

      const place = (source: PluginImportSource.Source, expected?: string) =>
        Effect.gen(function*() {
          const staging = yield* stage
          yield* bring(source, staging)
          const directory = yield* attempt(async () => {
            const directory = await pluginRoot(Path.join(staging, "content"))
            await inspectTree(directory)
            return directory
          })
          const plugin = yield* plugins.read(directory).pipe(
            Effect.mapError((invalid) => new Refused({ reason: invalid.reason }))
          )
          if (expected !== undefined && plugin.name !== expected) {
            return yield* new Refused({ reason: `the import holds ${plugin.name}, not ${expected}` })
          }
          return yield* swap.withPermits(1)(moveIntoPlace(directory, plugin.name, staging))
        }).pipe(
          Effect.scoped,
          Effect.provideContext(context),
          Effect.mapError((refused) => new PluginImportSource.ImportFailed({ reason: refused.reason }))
        )

      return place
    })

export const layer = Layer.effectContext(Effect.map(make, (place) =>
  Context.make(PluginImportSource.PluginImportSource, { place: (source) => place(source) }).pipe(
    Context.add(NamedImport, { place })
  )))
