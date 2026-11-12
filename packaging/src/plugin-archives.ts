import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { digestDirectory } from "@exangelos/plugin-directory"
import { Data, Effect } from "effect"
import { run } from "./command.ts"
import { clearReleaseFiles, pluginArchiveName, writeChecksums } from "./release-files.ts"
import { createTarGz, extractTarGz } from "./tar.ts"

export const officialPluginNames: ReadonlyArray<string> = ["github-pr", "jira", "file-watch"]

export const officialPluginsFileName = "official-plugins.json"

export interface OfficialPlugin {
  readonly name: string
  readonly version: string
  readonly digest: string
}

interface Manifest {
  readonly name: string
  readonly version: string
  readonly entry: { readonly _tag: "Bundle"; readonly path: string } | { readonly _tag: "Native" }
}

export class PluginManifestInvalid extends Data.TaggedError("PluginManifestInvalid")<{ readonly message: string }> {}

const readManifest = (pluginDirectory: string) => {
  const path = join(pluginDirectory, "plugin.json")
  return existsSync(path)
    ? Effect.sync(() => JSON.parse(readFileSync(path, "utf8")) as Manifest)
    : Effect.fail(new PluginManifestInvalid({ message: `${path} is missing; an official plugin needs a manifest to be archived` }))
}

export const bun = process.env["BUN"] ?? "bun"

const workDirectory = (name: string) =>
  Effect.acquireRelease(
    Effect.sync(() => mkdtempSync(join(tmpdir(), `xng-plugin-${name}-`))),
    (work) => Effect.sync(() => rmSync(work, { recursive: true, force: true }))
  )

export const buildPluginArchive = (pluginDirectory: string, outDirectory: string) =>
  Effect.gen(function*() {
    const manifest = yield* readManifest(pluginDirectory)
    if (manifest.entry._tag !== "Bundle") {
      return yield* new PluginManifestInvalid({ message: `${manifest.name}: only bundle entries are packaged` })
    }
    const entryPath = manifest.entry.path
    const work = yield* workDirectory(manifest.name)
    yield* run(bun, ["run", "build"], { cwd: pluginDirectory })
    const stage = join(work, "stage")
    yield* Effect.sync(() => {
      mkdirSync(dirname(join(stage, entryPath)), { recursive: true })
      copyFileSync(join(pluginDirectory, "plugin.json"), join(stage, "plugin.json"))
      copyFileSync(join(pluginDirectory, entryPath), join(stage, entryPath))
    })
    const archive = join(outDirectory, pluginArchiveName(manifest.name, manifest.version))
    yield* createTarGz(archive, stage, ["plugin.json", entryPath])
    const unpacked = join(work, "unpacked")
    yield* Effect.sync(() => mkdirSync(unpacked))
    yield* extractTarGz(archive, unpacked)
    const digest = yield* digestDirectory(unpacked)
    return { name: manifest.name, version: manifest.version, digest, archive }
  }).pipe(Effect.scoped)

export const buildPluginArchives = (pluginDirectories: ReadonlyArray<string>, outDirectory: string) =>
  Effect.gen(function*() {
    yield* Effect.sync(() => {
      clearReleaseFiles(outDirectory)
      mkdirSync(outDirectory, { recursive: true })
    })
    const built = yield* Effect.forEach(pluginDirectories, (directory) => buildPluginArchive(directory, outDirectory))
    const official: ReadonlyArray<OfficialPlugin> = built.map(({ name, version, digest }) => ({ name, version, digest }))
    yield* Effect.sync(() => {
      writeChecksums(outDirectory, built.map((plugin) => plugin.archive))
      writeFileSync(join(outDirectory, officialPluginsFileName), `${JSON.stringify(official, null, 2)}\n`)
    })
    return official
  })

export const readOfficialPlugins = (path: string): ReadonlyArray<OfficialPlugin> =>
  JSON.parse(readFileSync(path, "utf8")) as ReadonlyArray<OfficialPlugin>
