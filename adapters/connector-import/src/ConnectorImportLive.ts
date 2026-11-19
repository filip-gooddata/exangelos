import * as Fs from "node:fs/promises"
import * as Path from "node:path"
import { Context, Effect, Layer, Semaphore } from "effect"
import { ConnectorDirectory, ConnectorImportSource } from "@exangelos/application"
import { Paths } from "@exangelos/paths"
import { HttpClient } from "effect/http"
import { ChildProcessSpawner } from "effect/process"
import { unpack } from "./Archive.ts"
import { copyTree, inspectTree, limits, connectorRoot, Refused } from "./Entries.ts"
import { download } from "./Download.ts"
import { checkout } from "./Git.ts"

const reasonOf = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))

const attempt = <A>(f: () => Promise<A>) =>
  Effect.tryPromise({ try: f, catch: (cause) => (cause instanceof Refused ? cause : new Refused({ reason: reasonOf(cause) })) })

/**
 * Places an import only if its manifest names the expected connector. The name is checked while the
 * import is staged, so a mismatch never touches an installed connector. `layer` provides it beside the port.
 */
export class NamedImport extends Context.Service<NamedImport, {
  readonly place: (
    source: ConnectorImportSource.Source,
    name: string
  ) => Effect.Effect<string, ConnectorImportSource.ImportFailed>
}>()("@exangelos/connector-import/NamedImport") {}

/**
 * Places connectors from archives, https links, local directories and git repositories into the
 * connector directory at `Paths.connectorDir`. Each import is staged in a new directory beside the connector directory, checked,
 * and only then moved under the connector's manifest name. A failed import leaves the connector directory
 * as it was.
 */
const make = Effect.gen(function*() {
      const connectors = yield* ConnectorDirectory.ConnectorDirectory
      const context = yield* Effect.context<ChildProcessSpawner.ChildProcessSpawner | HttpClient.HttpClient>()
      const root = Path.resolve((yield* Paths.Paths).connectorDir)
      const swap = yield* Semaphore.make(1)

      const stage = Effect.acquireRelease(
        attempt(async () => {
          await Fs.mkdir(root, { recursive: true })
          return Fs.mkdtemp(Path.join(Path.dirname(root), `.${Path.basename(root)}-import-`))
        }),
        (staging) => Effect.promise(() => Fs.rm(staging, { recursive: true, force: true }))
      )

      const bring = (source: ConnectorImportSource.Source, staging: string) => {
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

      const protectLegacyState = async (name: string, path: string) => {
        if (name !== "slack") return
        const entries: ReadonlyArray<string> = await Fs.readdir(path).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return []
          throw error
        })
        const privateState = entries.some((entry) =>
          entry === "setup.lock" || entry === "setup.json" || entry.startsWith(".setup-") ||
          entry === "subscriptions-key.json" || /^scope-[a-f0-9]{64}\.json$/.test(entry) ||
          entry === "ledger.sqlite3" || entry.startsWith("ledger.sqlite3-")
        )
        if (privateState) {
          throw new Refused({ reason: "Slack private state occupies the install directory. Move the legacy state before importing Slack." })
        }
      }

      const moveIntoPlace = (directory: string, name: string, staging: string) =>
        attempt(async () => {
          const target = Path.join(root, name)
          const previous = Path.join(root, `.${name}.previous-${Path.basename(staging)}`)
          await protectLegacyState(name, target)
          const replaced = await Fs.rename(target, previous).then(() => true, () => false)
          try {
            if (replaced) await protectLegacyState(name, previous)
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

      const place = (source: ConnectorImportSource.Source, expected?: string) =>
        Effect.gen(function*() {
          const staging = yield* stage
          yield* bring(source, staging)
          const directory = yield* attempt(async () => {
            const directory = await connectorRoot(Path.join(staging, "content"))
            await inspectTree(directory)
            return directory
          })
          const connector = yield* connectors.read(directory).pipe(
            Effect.mapError((invalid) => new Refused({ reason: invalid.reason }))
          )
          if (expected !== undefined && connector.name !== expected) {
            return yield* new Refused({ reason: `the import holds ${connector.name}, not ${expected}` })
          }
          return yield* swap.withPermits(1)(moveIntoPlace(directory, connector.name, staging))
        }).pipe(
          Effect.scoped,
          Effect.provideContext(context),
          Effect.mapError((refused) => new ConnectorImportSource.ImportFailed({ reason: refused.reason }))
        )

      return place
    })

export const layer = Layer.effectContext(Effect.map(make, (place) =>
  Context.make(ConnectorImportSource.ConnectorImportSource, { place: (source) => place(source) }).pipe(
    Context.add(NamedImport, { place })
  )))
