import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { digestDirectory } from "@exangelos/connector-directory"
import { Data, Effect } from "effect"
import { run } from "./command.ts"
import { clearReleaseFiles, connectorArchiveName, writeChecksums } from "./release-files.ts"
import { createTarGz, extractTarGz } from "./tar.ts"

export const officialConnectorNames: ReadonlyArray<string> = ["github-pr", "jira", "file-watch"]

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
}

export class ConnectorManifestInvalid extends Data.TaggedError("ConnectorManifestInvalid")<{ readonly message: string }> {}

const readManifest = (connectorDirectory: string) => {
  const path = join(connectorDirectory, "connector.json")
  return existsSync(path)
    ? Effect.sync(() => JSON.parse(readFileSync(path, "utf8")) as Manifest)
    : Effect.fail(new ConnectorManifestInvalid({ message: `${path} is missing; an official connector needs a manifest to be archived` }))
}

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
    const stage = join(work, "stage")
    yield* Effect.sync(() => {
      mkdirSync(dirname(join(stage, entryPath)), { recursive: true })
      copyFileSync(join(connectorDirectory, "connector.json"), join(stage, "connector.json"))
      copyFileSync(join(connectorDirectory, entryPath), join(stage, entryPath))
    })
    const archive = join(outDirectory, connectorArchiveName(manifest.name, manifest.version))
    yield* createTarGz(archive, stage, ["connector.json", entryPath])
    const unpacked = join(work, "unpacked")
    yield* Effect.sync(() => mkdirSync(unpacked))
    yield* extractTarGz(archive, unpacked)
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
