import { copyFileSync, readFileSync } from "node:fs"
import { basename, join, resolve } from "node:path"
import { Effect } from "effect"
import { buildBinaries, type BuiltBinary } from "./binaries.ts"
import { buildPluginArchives, officialPluginNames, type OfficialPlugin } from "./plugin-archives.ts"
import { clearReleaseFiles, pluginArchiveName, targets, type Target, writeChecksums } from "./release-files.ts"

export const packagingDirectory = resolve(import.meta.dirname, "..")
export const repositoryDirectory = resolve(packagingDirectory, "..")
export const defaultOfficialPluginsDirectory = join(packagingDirectory, "dist", "official-plugins")
export const defaultReleaseDirectory = join(packagingDirectory, "dist", "release")
export const defaultBuildScript = join(repositoryDirectory, "apps", "cli", "build.ts")

export const packagingVersion = (): string =>
  (JSON.parse(readFileSync(join(packagingDirectory, "package.json"), "utf8")) as { readonly version: string }).version

export const officialPluginDirectories = (pluginsRoot = join(repositoryDirectory, "plugins")): ReadonlyArray<string> =>
  officialPluginNames.map((name) => join(pluginsRoot, name))

export interface ReleaseBuild {
  readonly buildScript: string
  readonly version: string
  readonly pluginDirectories: ReadonlyArray<string>
  readonly officialPluginsDirectory: string
  readonly releaseDirectory: string
  readonly targets?: ReadonlyArray<Target>
}

export interface Release {
  readonly officialPlugins: ReadonlyArray<OfficialPlugin>
  readonly binaries: ReadonlyArray<BuiltBinary>
  readonly checksums: string
}

export const buildRelease = (build: ReleaseBuild) =>
  Effect.gen(function*() {
    yield* Effect.sync(() => clearReleaseFiles(build.releaseDirectory))
    const officialPlugins = yield* buildPluginArchives(build.pluginDirectories, build.officialPluginsDirectory)
    const binaries = yield* buildBinaries({
      buildScript: build.buildScript,
      version: build.version,
      officialPlugins,
      targets: build.targets ?? targets,
      outDirectory: build.releaseDirectory
    })
    return yield* Effect.sync((): Release => {
      const pluginArchives = officialPlugins.map((plugin) => {
        const name = pluginArchiveName(plugin.name, plugin.version)
        copyFileSync(join(build.officialPluginsDirectory, name), join(build.releaseDirectory, name))
        return join(build.releaseDirectory, name)
      })
      const checksums = writeChecksums(build.releaseDirectory, [...binaries.map((built) => built.archive), ...pluginArchives])
      return { officialPlugins, binaries, checksums }
    })
  })

export const describeRelease = (release: Release): string =>
  [
    ...release.binaries.map((built) => `${built.target.bunTarget}: ${basename(built.archive)}`),
    ...release.officialPlugins.map((plugin) => `${plugin.name} ${plugin.version}: ${plugin.digest}`),
    release.checksums
  ].join("\n")
