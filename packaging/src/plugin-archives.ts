import { execFileSync } from "node:child_process"
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { digestDirectory } from "./digest.ts"
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

const readManifest = (pluginDirectory: string): Manifest => {
  const path = join(pluginDirectory, "plugin.json")
  if (!existsSync(path)) throw new Error(`${path} is missing; an official plugin needs a manifest to be archived`)
  return JSON.parse(readFileSync(path, "utf8")) as Manifest
}

export const bun = process.env["BUN"] ?? "bun"

// Stages plugin.json and the bundle of src/index.ts at the manifest's entry path,
// archives them at the archive root, and digests the unpacked archive the way the
// daemon digests an installed plugin.
export const buildPluginArchive = (pluginDirectory: string, outDirectory: string): OfficialPlugin & { readonly archive: string } => {
  const manifest = readManifest(pluginDirectory)
  if (manifest.entry._tag !== "Bundle") throw new Error(`${manifest.name}: only bundle entries are packaged`)
  const entryPath = manifest.entry.path
  const work = mkdtempSync(join(tmpdir(), `xng-plugin-${manifest.name}-`))
  try {
    const stage = join(work, "stage")
    mkdirSync(dirname(join(stage, entryPath)), { recursive: true })
    copyFileSync(join(pluginDirectory, "plugin.json"), join(stage, "plugin.json"))
    execFileSync(bun, ["build", join(pluginDirectory, "src", "index.ts"), "--target=bun", "--format=esm", `--outfile=${join(stage, entryPath)}`], {
      stdio: ["ignore", "ignore", "inherit"]
    })
    const archive = join(outDirectory, pluginArchiveName(manifest.name, manifest.version))
    createTarGz(archive, stage, ["plugin.json", entryPath])
    const unpacked = join(work, "unpacked")
    mkdirSync(unpacked)
    extractTarGz(archive, unpacked)
    return { name: manifest.name, version: manifest.version, digest: digestDirectory(unpacked), archive }
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

export const buildPluginArchives = (pluginDirectories: ReadonlyArray<string>, outDirectory: string): ReadonlyArray<OfficialPlugin> => {
  clearReleaseFiles(outDirectory)
  mkdirSync(outDirectory, { recursive: true })
  const built = pluginDirectories.map((directory) => buildPluginArchive(directory, outDirectory))
  writeChecksums(outDirectory, built.map((plugin) => plugin.archive))
  const official = built.map(({ name, version, digest }) => ({ name, version, digest }))
  writeFileSync(join(outDirectory, officialPluginsFileName), `${JSON.stringify(official, null, 2)}\n`)
  return official
}

export const readOfficialPlugins = (path: string): ReadonlyArray<OfficialPlugin> =>
  JSON.parse(readFileSync(path, "utf8")) as ReadonlyArray<OfficialPlugin>
