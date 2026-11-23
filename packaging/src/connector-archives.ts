import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path"
import { digestDirectory } from "@exangelos/connector-directory"
import { inspectTree, unpack } from "@exangelos/connector-import"
import { Data, Effect } from "effect"
import { run } from "./command.ts"
import { clearReleaseFiles, connectorArchiveName, writeChecksums } from "./release-files.ts"
import { createTarGz } from "./tar.ts"

export const officialConnectorNames: ReadonlyArray<string> = ["github-pr", "jira", "file-watch", "slack", "teams"]

export const officialConnectorsFileName = "official-connectors.json"

export interface OfficialConnector {
  readonly name: string
  readonly version: string
  readonly digest: string
}

interface Manifest {
  readonly name: string
  readonly version: string
  readonly entry: { readonly _tag: "Bundle"; readonly path: string } | { readonly _tag: "Native" }
  readonly files?: ReadonlyArray<string>
  readonly icon?: string
}

export class ConnectorManifestInvalid extends Data.TaggedError("ConnectorManifestInvalid")<{ readonly message: string }> {}

const readManifest = (connectorDirectory: string) => {
  const path = join(connectorDirectory, "connector.json")
  return existsSync(path)
    ? Effect.sync(() => JSON.parse(readFileSync(path, "utf8")) as Manifest)
    : Effect.fail(new ConnectorManifestInvalid({ message: `${path} is missing; an official connector needs a manifest to be archived` }))
}

const isInside = (root: string, path: string) => {
  const rel = relative(root, path)
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

const filesUnder = (root: string, path: string): ReadonlyArray<string> => {
  const stat = lstatSync(path)
  if (stat.isSymbolicLink()) {
    throw new ConnectorManifestInvalid({ message: `${path} is a link; a connector archive carries ordinary files only` })
  }
  if (stat.isDirectory()) {
    return readdirSync(path).toSorted().flatMap((child) => filesUnder(root, join(path, child)))
  }
  if (!stat.isFile()) {
    throw new ConnectorManifestInvalid({ message: `${path} is not an ordinary file` })
  }
  return [relative(root, path).split(sep).join("/")]
}

const declaredFiles = (connectorDirectory: string, manifest: Manifest) =>
  Effect.try({
    try: () => {
      const root = realpathSync(connectorDirectory)
      const declared = [
        ...(manifest.files ?? []).map((path) => ["file", path] as const),
        ...(manifest.icon === undefined ? [] : [["icon", manifest.icon] as const])
      ]
      return declared.flatMap(([kind, declared]) => {
        const path = resolve(root, declared)
        if (isAbsolute(declared) || !isInside(root, path)) {
          throw new ConnectorManifestInvalid({ message: `${manifest.name}: ${kind} ${declared} is outside the connector folder` })
        }
        if (!existsSync(path)) {
          throw new ConnectorManifestInvalid({ message: `${manifest.name}: ${kind} ${declared} does not exist` })
        }
        if (realpathSync(path) !== path) {
          throw new ConnectorManifestInvalid({ message: `${manifest.name}: ${kind} ${declared} is a link or goes through one` })
        }
        if (kind === "icon" && !lstatSync(path).isFile()) {
          throw new ConnectorManifestInvalid({ message: `${manifest.name}: icon ${declared} is not an ordinary file` })
        }
        return filesUnder(root, path)
      })
    },
    catch: (error) =>
      error instanceof ConnectorManifestInvalid ? error : new ConnectorManifestInvalid({ message: `${manifest.name}: ${String(error)}` })
  })

export const bun = process.env["BUN"] ?? "bun"

const workDirectory = (name: string) =>
  Effect.acquireRelease(
    Effect.sync(() => mkdtempSync(join(tmpdir(), `xng-connector-${name}-`))),
    (work) => Effect.sync(() => rmSync(work, { recursive: true, force: true }))
  )

export const buildConnectorArchive = (connectorDirectory: string, outDirectory: string) =>
  Effect.gen(function*() {
    const manifest = yield* readManifest(connectorDirectory)
    if (manifest.entry._tag !== "Bundle") {
      return yield* new ConnectorManifestInvalid({ message: `${manifest.name}: only bundle entries are packaged` })
    }
    const entryPath = manifest.entry.path
    const work = yield* workDirectory(manifest.name)
    yield* run(bun, ["run", "build"], { cwd: connectorDirectory })
    const extra = yield* declaredFiles(connectorDirectory, manifest)
    const packed = new Set(["connector.json", posix.normalize(entryPath)])
    const entries = ["connector.json", entryPath, ...new Set(extra.filter((file) => !packed.has(file)))]
    const stage = join(work, "stage")
    yield* Effect.sync(() => {
      for (const entry of entries) {
        mkdirSync(dirname(join(stage, entry)), { recursive: true })
        copyFileSync(join(connectorDirectory, entry), join(stage, entry))
      }
    })
    const archive = join(outDirectory, connectorArchiveName(manifest.name, manifest.version))
    yield* createTarGz(archive, stage, entries)
    const unpacked = join(work, "unpacked")
    yield* Effect.tryPromise({
      try: () => unpack(archive, unpacked).then(() => inspectTree(unpacked)),
      catch: (error) =>
        new ConnectorManifestInvalid({
          message: `${manifest.name}: the archive would be refused on import: ${
            typeof error === "object" && error !== null && "reason" in error ? String(error.reason) : String(error)
          }`
        })
    })
    const digest = yield* digestDirectory(unpacked)
    return { name: manifest.name, version: manifest.version, digest, archive }
  }).pipe(Effect.scoped)

export const buildConnectorArchives = (connectorDirectories: ReadonlyArray<string>, outDirectory: string) =>
  Effect.gen(function*() {
    yield* Effect.sync(() => {
      clearReleaseFiles(outDirectory)
      mkdirSync(outDirectory, { recursive: true })
    })
    const built = yield* Effect.forEach(connectorDirectories, (directory) => buildConnectorArchive(directory, outDirectory))
    const official: ReadonlyArray<OfficialConnector> = built.map(({ name, version, digest }) => ({ name, version, digest }))
    yield* Effect.sync(() => {
      writeChecksums(outDirectory, built.map((connector) => connector.archive))
      writeFileSync(join(outDirectory, officialConnectorsFileName), `${JSON.stringify(official, null, 2)}\n`)
    })
    return official
  })

export const readOfficialConnectors = (path: string): ReadonlyArray<OfficialConnector> =>
  JSON.parse(readFileSync(path, "utf8")) as ReadonlyArray<OfficialConnector>
