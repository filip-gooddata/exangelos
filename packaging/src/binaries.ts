import { execFileSync } from "node:child_process"
import { copyFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import type { OfficialPlugin } from "./plugin-archives.ts"
import { bun } from "./plugin-archives.ts"
import { binaryArchiveName, platformOf, type Target } from "./release-files.ts"
import { createTarGz } from "./tar.ts"

export interface BinaryBuild {
  readonly buildScript: string
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

const adHocSign = (binary: string, target: Target): void => {
  if (target.os === "darwin" && process.platform === "darwin") {
    execFileSync("codesign", ["--sign", "-", "--force", binary], { stdio: ["ignore", "ignore", "inherit"] })
  }
}

export const buildBinaries = (build: BinaryBuild): ReadonlyArray<BuiltBinary> => {
  const binaries = join(build.outDirectory, "binaries")
  const sidecars = join(build.outDirectory, "sidecars")
  mkdirSync(build.outDirectory, { recursive: true })
  mkdirSync(sidecars, { recursive: true })
  return build.targets.map((target) => {
    const directory = join(binaries, platformOf(target))
    mkdirSync(directory, { recursive: true })
    const binary = join(directory, "exangelos")
    execFileSync(
      bun,
      [
        build.buildScript,
        `--target=${target.bunTarget}`,
        "--version",
        build.version,
        "--official-plugins",
        JSON.stringify(build.officialPlugins),
        "--outfile",
        binary
      ],
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
