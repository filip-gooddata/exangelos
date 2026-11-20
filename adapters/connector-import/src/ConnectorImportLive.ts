import * as Fs from "node:fs/promises"
import * as Path from "node:path"
import { Context, Effect, Layer, Option, Semaphore } from "effect"
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
  /**
   * Places the import like `place`, but only when its digest is `digest`. Beside it, it keeps the
   * earlier copy (or a mark that there was none) and `note`, until `discard`. It refuses while anything
   * is still kept.
   */
  readonly replace: (
    source: ConnectorImportSource.Source,
    name: string,
    digest: string,
    note: string
  ) => Effect.Effect<string, ConnectorImportSource.ImportFailed>
  /**
   * Puts back the earlier copy `replace` kept, or removes the import when there was none. The note
   * stays until `discard`, so the caller can finish with it after a crash. Repeating it does nothing.
   */
  readonly restore: (name: string) => Effect.Effect<void, ConnectorImportSource.ImportFailed>
  /** Deletes everything `replace` kept, note included. */
  readonly discard: (name: string) => Effect.Effect<void>
  /** The note of a `replace` not yet discarded. */
  readonly kept: (name: string) => Effect.Effect<Option.Option<string>, ConnectorImportSource.ImportFailed>
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

      const kept = (name: string) => Path.join(root, `.${name}.previous`)
      const isPresent = (path: string) => Fs.stat(path).then(() => true, () => false)
      const noteOf = (name: string) => `${kept(name)}.note`
      const anyKept = async (name: string) =>
        (await isPresent(kept(name))) || (await isPresent(`${kept(name)}.absent`)) || (await isPresent(noteOf(name)))
      const keptNote = (name: string) =>
        attempt(() => Fs.readFile(noteOf(name), "utf8").then(Option.some, (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return Option.none<string>()
          throw error
        })).pipe(Effect.mapError((refused) => new ConnectorImportSource.ImportFailed({ reason: refused.reason })))

      const moveIntoPlace = (directory: string, name: string, previous: string) =>
        attempt(async () => {
          const target = Path.join(root, name)
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
          return { target, previous: replaced ? previous : undefined }
        })

      /**
       * Like moveIntoPlace, but when no copy is installed it notes at `previous` that there was none, so
       * restore can remove the new copy. Runs under the swap permit, so the check and the move are one step.
       */
      const moveKeeping = (note: string) => (directory: string, name: string, previous: string) =>
        Effect.gen(function*() {
          const absent = `${previous}.absent`
          yield* attempt(async () => {
            await Fs.writeFile(noteOf(name), note, { flag: "wx" })
            if (!(await isPresent(Path.join(root, name)))) await Fs.writeFile(absent, "", { flag: "wx" })
          }).pipe(Effect.tapError(() => Effect.promise(() => Fs.rm(noteOf(name), { force: true }))))
          return yield* moveIntoPlace(directory, name, previous).pipe(
            Effect.tapError(() =>
              Effect.promise(async () => {
                await Fs.rm(absent, { force: true })
                await Fs.rm(noteOf(name), { force: true })
              })
            )
          )
        })

      const removeTree = (path: string | undefined) =>
        path === undefined ? Effect.void : Effect.promise(() => Fs.rm(path, { recursive: true, force: true }))

      const putBack = (name: string) =>
        attempt(async () => {
          const target = Path.join(root, name)
          const previous = kept(name)
          const failed = `${previous}.failed`
          if (await isPresent(previous)) {
            await Fs.rm(failed, { recursive: true, force: true })
            const moved = await Fs.rename(target, failed).then(() => true, () => false)
            try {
              await Fs.rename(previous, target)
            } catch (error) {
              if (moved) await Fs.rename(failed, target)
              throw error
            }
            await Fs.rm(failed, { recursive: true, force: true })
          } else if (await isPresent(`${previous}.absent`)) {
            await Fs.rm(target, { recursive: true, force: true })
          }
          await Fs.rm(`${previous}.absent`, { force: true })
        })

      const staged = (
        source: ConnectorImportSource.Source,
        expected: string | undefined,
        digest: string | undefined,
        previous: (name: string, staging: string) => string,
        note: string | undefined
      ) =>
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
          if (digest !== undefined && connector.digest !== digest) {
            return yield* new Refused({ reason: `the import's digest ${connector.digest} is not the expected ${digest}` })
          }
          return yield* Effect.uninterruptible(
            swap.withPermits(1)(
              (note !== undefined ? moveKeeping(note) : moveIntoPlace)(directory, connector.name, previous(connector.name, staging))
            )
          )
        }).pipe(
          Effect.scoped,
          Effect.provideContext(context)
        )

      const failed = (refused: Refused) => new ConnectorImportSource.ImportFailed({ reason: refused.reason })

      const place = (source: ConnectorImportSource.Source, expected?: string) =>
        staged(source, expected, undefined, (name, staging) => Path.join(root, `.${name}.previous-${Path.basename(staging)}`), undefined).pipe(
          Effect.tap(({ previous }) => removeTree(previous)),
          Effect.map(({ target }) => target),
          Effect.mapError(failed)
        )

      const discard = (name: string) =>
        Effect.andThen(
          Effect.andThen(removeTree(kept(name)), removeTree(`${kept(name)}.absent`)),
          removeTree(noteOf(name))
        )

      const replace = (source: ConnectorImportSource.Source, expected: string, digest: string, note: string) =>
        attempt(async () => {
          if (await anyKept(expected)) {
            throw new Refused({ reason: `an earlier copy of ${expected} is still kept at ${kept(expected)}` })
          }
        }).pipe(
          Effect.andThen(staged(source, expected, digest, kept, note)),
          Effect.map(({ target }) => target),
          Effect.mapError(failed)
        )

      const restore = (name: string) => swap.withPermits(1)(putBack(name)).pipe(Effect.mapError(failed))

      return { place, replace, restore, discard, kept: keptNote }
    })

export const layer = Layer.effectContext(Effect.map(make, ({ place, replace, restore, discard, kept }) =>
  Context.make(ConnectorImportSource.ConnectorImportSource, { place: (source) => place(source) }).pipe(
    Context.add(NamedImport, { place, replace, restore, discard, kept })
  )))
