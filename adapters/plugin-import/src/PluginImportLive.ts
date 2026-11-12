import * as Fs from "node:fs/promises"
import * as Path from "node:path"
import { Effect, Layer, Semaphore } from "effect"
import { PluginDirectory, PluginImportSource } from "@exangelos/application"
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
 * Places plugins from archives, https links, local directories and git repositories into the
 * plugin directory. Each import is staged in a new directory beside the plugin directory, checked,
 * and only then moved under the plugin's manifest name. A failed import leaves the plugin directory
 * as it was.
 */
export const layer = (options: { readonly directory: string }) =>
  Layer.effect(
    PluginImportSource.PluginImportSource,
    Effect.gen(function*() {
      const plugins = yield* PluginDirectory.PluginDirectory
      const context = yield* Effect.context<ChildProcessSpawner.ChildProcessSpawner | HttpClient.HttpClient>()
      const root = Path.resolve(options.directory)
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
          const previous = Path.join(staging, "previous")
          const replaced = await Fs.rename(target, previous).then(() => true, () => false)
          try {
            await Fs.rename(directory, target)
          } catch (error) {
            if (replaced) await Fs.rename(previous, target)
            throw error
          }
          return target
        })

      const place = (source: PluginImportSource.Source) =>
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
          return yield* swap.withPermits(1)(moveIntoPlace(directory, plugin.name, staging))
        }).pipe(
          Effect.scoped,
          Effect.provideContext(context),
          Effect.mapError((refused) => new PluginImportSource.ImportFailed({ reason: refused.reason }))
        )

      return { place }
    })
  )
