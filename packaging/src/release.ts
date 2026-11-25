import { copyFileSync, readFileSync } from "node:fs"
import { basename, join, resolve } from "node:path"
import { Effect } from "effect"
import { buildBinaries, type BuiltBinary } from "./binaries.ts"
import { buildConnectorArchives, officialConnectorNames, officialConnectorsFileName, type OfficialConnector } from "./connector-archives.ts"
import { clearReleaseFiles, connectorArchiveName, targets, type Target, writeChecksums } from "./release-files.ts"

export const packagingDirectory = resolve(import.meta.dirname, "..")
export const repositoryDirectory = resolve(packagingDirectory, "..")
export const defaultOfficialConnectorsDirectory = join(packagingDirectory, "dist", "official-connectors")
export const defaultReleaseDirectory = join(packagingDirectory, "dist", "release")
export const defaultBuildScript = join(repositoryDirectory, "apps", "cli", "build.ts")

export const packagingVersion = (): string =>
  (JSON.parse(readFileSync(join(packagingDirectory, "package.json"), "utf8")) as { readonly version: string }).version

export const officialConnectorDirectories = (connectorsRoot = join(repositoryDirectory, "connectors")): ReadonlyArray<string> =>
  officialConnectorNames.map((name) => join(connectorsRoot, name))

export interface ReleaseBuild {
  readonly buildScript: string
  readonly version: string
  readonly releaseUrl: string
  readonly connectorDirectories: ReadonlyArray<string>
  readonly officialConnectorsDirectory: string
  readonly releaseDirectory: string
  readonly targets?: ReadonlyArray<Target>
  readonly signingIdentity?: string | undefined
}

export interface Release {
  readonly officialConnectors: ReadonlyArray<OfficialConnector>
  readonly binaries: ReadonlyArray<BuiltBinary>
  readonly checksums: string
}

export const buildRelease = (build: ReleaseBuild) =>
  Effect.gen(function*() {
    yield* Effect.sync(() => clearReleaseFiles(build.releaseDirectory))
    const officialConnectors = yield* buildConnectorArchives(build.connectorDirectories, build.officialConnectorsDirectory)
    const binaries = yield* buildBinaries({
      buildScript: build.buildScript,
      version: build.version,
      releaseUrl: build.releaseUrl,
      officialConnectors,
      targets: build.targets ?? targets,
      outDirectory: build.releaseDirectory,
      signingIdentity: build.signingIdentity
    })
    return yield* Effect.sync((): Release => {
      const connectorArchives = officialConnectors.map((connector) => {
        const name = connectorArchiveName(connector.name, connector.version)
        copyFileSync(join(build.officialConnectorsDirectory, name), join(build.releaseDirectory, name))
        return join(build.releaseDirectory, name)
      })
      const officialConnectorsFile = join(build.releaseDirectory, officialConnectorsFileName)
      copyFileSync(join(build.officialConnectorsDirectory, officialConnectorsFileName), officialConnectorsFile)
      const checksums = writeChecksums(build.releaseDirectory, [
        ...binaries.map((built) => built.archive),
        ...connectorArchives,
        officialConnectorsFile
      ])
      return { officialConnectors, binaries, checksums }
    })
  })

export const describeRelease = (release: Release): string =>
  [
    ...release.binaries.map((built) => `${built.target.bunTarget}: ${basename(built.archive)}`),
    ...release.officialConnectors.map((connector) => `${connector.name} ${connector.version}: ${connector.digest}`),
    release.checksums
  ].join("\n")
