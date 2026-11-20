import { Context, Effect, Layer, PubSub, Ref, Stream } from "effect"
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
            const f = yield* Ref.get(files)
            const release = f.releases.get(official.name)
            const failed = (reason: string) => new OfficialFetchFailed({ connector: official.name, reason })
            if (release === undefined) return yield* failed("offline")
            if (release.digest !== official.digest) return yield* failed(`the digest ${release.digest} is not ${official.digest}`)
            const placed = inRoot(release)
            const previous = f.directories.get(placed.directory)
            yield* place(placed)
            return {
              directory: placed.directory,
              restore: Ref.update(files, (now) => {
                const directories = new Map(now.directories)
                if (previous === undefined) directories.delete(placed.directory)
                else directories.set(placed.directory, previous)
                return { ...now, directories }
              }),
              discard: Effect.void
            }
          })
      }),
      Layer.succeed(ConnectorFilesFake, {
        replacements: Ref.get(replacements),
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
