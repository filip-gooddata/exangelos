import { Context, Deferred, Effect, Layer, PubSub, Ref, Stream } from "effect"
import type { Ids } from "@exangelos/domain"
import { OfficialFetchFailed, OfficialConnectorSource, type Official } from "../ports/OfficialConnectorSource.ts"
import { ManifestInvalid, ConnectorDirectory, type Installed } from "../ports/ConnectorDirectory.ts"
import { ImportFailed, ConnectorImportSource, type Source } from "../ports/ConnectorImportSource.ts"

export const connectorRoot = "/connectors"

const inRoot = (connector: Installed): Installed => ({ ...connector, directory: `${connectorRoot}/${connector.name}` })

interface Files {
  readonly directories: ReadonlyMap<string, Installed>
  readonly sources: ReadonlyMap<string, Installed>
  readonly releases: ReadonlyMap<Ids.ConnectorName, Installed>
}

export class ConnectorFilesFake extends Context.Service<ConnectorFilesFake, {
  /** Puts connector files at `connector.directory`, as a dev link sees them; under `connectorRoot` they are listed. */
  readonly put: (connector: Installed) => Effect.Effect<void>
  /** Importing the source will place the connector in the connector directory. */
  readonly offer: (source: Source, connector: Installed) => Effect.Effect<void>
  /** The official source will serve the connector; a digest unlike the known one stands for a tampered archive. */
  readonly publish: (connector: Installed) => Effect.Effect<void>
  /** Changes the files in the directory: they get the digest, and `changes` emits for the directory. */
  readonly edit: (directory: string, digest: string) => Effect.Effect<void>
  /** How many times the official source was asked to replace an installed copy. */
  readonly replacements: Effect.Effect<number>
  /** Holds every later replace of the official source, before or after its swap, until the returned effect runs. */
  readonly holdReplace: (at: "before" | "after") => Effect.Effect<Effect.Effect<void>>
  /** The next `count` restores of the official source fail. */
  readonly failRestores: (count: number) => Effect.Effect<void>
}>()("@exangelos/application/testing/ConnectorFilesFake") {}

/**
 * ConnectorDirectory, ConnectorImportSource and OfficialConnectorSource over one in-memory file tree, so a
 * placed or fetched connector is then listed and read. Official connectors not yet published fail to fetch.
 */
export const layerConnectorFiles = (known: ReadonlyArray<Official>): Layer.Layer<
  ConnectorDirectory | ConnectorImportSource | OfficialConnectorSource | ConnectorFilesFake
> =>
  Layer.unwrap(Effect.gen(function*() {
    const files = yield* Ref.make<Files>({ directories: new Map(), sources: new Map(), releases: new Map() })
    const changed = yield* PubSub.unbounded<string>()
    const replacements = yield* Ref.make(0)
    const keptCopies = yield* Ref.make(new Map<string, Installed | undefined>())
    const restoreFailures = yield* Ref.make(0)
    const held = yield* Ref.make<{ readonly at: "before" | "after"; readonly hold: Deferred.Deferred<void> } | undefined>(undefined)
    const wait = (at: "before" | "after") =>
      Effect.flatMap(Ref.get(held), (h) => h !== undefined && h.at === at ? Deferred.await(h.hold) : Effect.void)
    const place = (connector: Installed) =>
      Effect.as(Ref.update(files, (f) => ({ ...f, directories: new Map(f.directories).set(connector.directory, connector) })), connector.directory)

    return Layer.mergeAll(
      Layer.succeed(ConnectorDirectory, {
        list: Effect.map(Ref.get(files), (f) =>
          [...f.directories.values()]
            .filter((connector) => connector.directory.startsWith(`${connectorRoot}/`))
            .sort((a, b) => a.name.localeCompare(b.name))),
        read: (directory) =>
          Effect.flatMap(Ref.get(files), (f) => {
            const connector = f.directories.get(directory)
            return connector === undefined
              ? Effect.fail(new ManifestInvalid({ directory, reason: "no manifest" }))
              : Effect.succeed(connector)
          }),
        remove: (name) =>
          Ref.update(files, (f) => {
            const directories = new Map(f.directories)
            directories.delete(`${connectorRoot}/${name}`)
            return { ...f, directories }
          }),
        changes: (directory) =>
          Stream.fromPubSub(changed).pipe(
            Stream.filter((path) => path === directory),
            Stream.map(() => undefined)
          )
      }),
      Layer.succeed(ConnectorImportSource, {
        place: (source) =>
          Effect.flatMap(Ref.get(files), (f) => {
            const connector = f.sources.get(JSON.stringify(source))
            return connector === undefined
              ? Effect.fail(new ImportFailed({ reason: `nothing to import at ${JSON.stringify(source)}` }))
              : place(inRoot(connector))
          })
      }),
      Layer.succeed(OfficialConnectorSource, {
        known,
        fetch: (official) =>
          Effect.flatMap(Ref.get(files), (f) => {
            const connector = f.releases.get(official.name)
            return connector === undefined
              ? Effect.fail(new OfficialFetchFailed({ connector: official.name, reason: "offline" }))
              : place(inRoot(connector))
          }),
        replace: (official) =>
          Effect.gen(function*() {
            yield* Ref.update(replacements, (n) => n + 1)
            yield* wait("before")
            const f = yield* Ref.get(files)
            const release = f.releases.get(official.name)
            const failed = (reason: string) => new OfficialFetchFailed({ connector: official.name, reason })
            if (release === undefined) return yield* failed("offline")
            if (release.digest !== official.digest) return yield* failed(`the digest ${release.digest} is not ${official.digest}`)
            const placed = inRoot(release)
            if ((yield* Ref.get(keptCopies)).has(placed.directory)) return yield* failed("an earlier copy is still kept")
            yield* Effect.uninterruptible(Effect.andThen(
              Ref.update(keptCopies, (m) => new Map(m).set(placed.directory, f.directories.get(placed.directory))),
              place(placed)
            ))
            yield* wait("after")
            return placed.directory
          }),
        restore: (official) =>
          Effect.gen(function*() {
            const directory = `${connectorRoot}/${official.name}`
            const copies = yield* Ref.get(keptCopies)
            if (!copies.has(directory)) return
            if ((yield* Ref.getAndUpdate(restoreFailures, (n) => Math.max(0, n - 1))) > 0) {
              return yield* new OfficialFetchFailed({ connector: official.name, reason: "rename failed" })
            }
            const previous = copies.get(directory)
            yield* Ref.update(files, (now) => {
              const directories = new Map(now.directories)
              if (previous === undefined) directories.delete(directory)
              else directories.set(directory, previous)
              return { ...now, directories }
            })
            yield* Ref.update(keptCopies, (m) => { const next = new Map(m); next.delete(directory); return next })
          }),
        kept: (official) => Effect.map(Ref.get(keptCopies), (m) => m.has(`${connectorRoot}/${official.name}`)),
        discard: (official) =>
          Ref.update(keptCopies, (m) => { const next = new Map(m); next.delete(`${connectorRoot}/${official.name}`); return next })
      }),
      Layer.succeed(ConnectorFilesFake, {
        replacements: Ref.get(replacements),
        failRestores: (count) => Ref.set(restoreFailures, count),
        holdReplace: (at) =>
          Effect.flatMap(Deferred.make<void>(), (hold) =>
            Effect.as(Ref.set(held, { at, hold }), Effect.asVoid(Deferred.succeed(hold, undefined)))),
        put: (connector) => Effect.asVoid(place(connector)),
        offer: (source, connector) =>
          Ref.update(files, (f) => ({ ...f, sources: new Map(f.sources).set(JSON.stringify(source), connector) })),
        publish: (connector) =>
          Ref.update(files, (f) => ({ ...f, releases: new Map(f.releases).set(connector.name, connector) })),
        edit: (directory, digest) =>
          Effect.andThen(
            Ref.update(files, (f) => {
              const connector = f.directories.get(directory)
              return connector === undefined
                ? f
                : { ...f, directories: new Map(f.directories).set(directory, { ...connector, digest }) }
            }),
            PubSub.publish(changed, directory)
          )
      })
    )
  }))
