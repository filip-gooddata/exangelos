import { execFileSync } from "node:child_process"
import { copyFileSync, mkdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import type { OfficialPlugin } from "./plugin-archives.ts"
import { bun } from "./plugin-archives.ts"
import { binaryArchiveName, platformOf, type Target } from "./release-files.ts"
import { createTarGz } from "./tar.ts"

export interface BinaryBuild {
  readonly entry: string
  readonly version: string
  readonly officialPlugins: ReadonlyArray<OfficialPlugin>
  readonly targets: ReadonlyArray<Target>
  readonly outDirectory: string
}

export interface BuiltBinary {
  readonly target: Target
  readonly binary: string
  readonly archive: string
  readonly sidecar: string
}

export const compileDefines = (version: string, officialPlugins: ReadonlyArray<OfficialPlugin>): ReadonlyArray<string> => [
  `--define=EXANGELOS_VERSION=${JSON.stringify(version)}`,
  `--define=EXANGELOS_OFFICIAL_PLUGINS=${JSON.stringify(officialPlugins)}`
]

const adHocSign = (binary: string, target: Target): void => {
  if (target.os === "darwin" && process.platform === "darwin") {
    execFileSync("codesign", ["--sign", "-", "--force", binary], { stdio: ["ignore", "ignore", "inherit"] })
  }
}

// Compiles one binary per target, ad-hoc signs the macOS ones when the host can,
// and leaves for each target a release archive holding `exangelos` and a copy named
// with the Rust target triple, which is the name Tauri expects for a sidecar.
export const buildBinaries = (build: BinaryBuild): ReadonlyArray<BuiltBinary> => {
  const binaries = join(build.outDirectory, "binaries")
  const sidecars = join(build.outDirectory, "sidecars")
  mkdirSync(build.outDirectory, { recursive: true })
  rmSync(binaries, { recursive: true, force: true })
  rmSync(sidecars, { recursive: true, force: true })
  mkdirSync(sidecars, { recursive: true })
  return build.targets.map((target) => {
    const directory = join(binaries, platformOf(target))
    mkdirSync(directory, { recursive: true })
    const binary = join(directory, "exangelos")
    execFileSync(
      bun,
      ["build", "--compile", `--target=${target.bunTarget}`, ...compileDefines(build.version, build.officialPlugins), build.entry, `--outfile=${binary}`],
      { stdio: ["ignore", "ignore", "inherit"] }
    )
    adHocSign(binary, target)
    const archive = join(build.outDirectory, binaryArchiveName(build.version, target))
    createTarGz(archive, directory, ["exangelos"])
    const sidecar = join(sidecars, `exangelos-${target.rustTriple}`)
    copyFileSync(binary, sidecar)
    return { target, binary, archive, sidecar }
  })
}
