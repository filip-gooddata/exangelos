import { copyFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { Effect } from "effect"
import { run } from "./command.ts"
import type { OfficialPlugin } from "./plugin-archives.ts"
import { bun } from "./plugin-archives.ts"
import { binaryArchiveName, platformOf, type Target } from "./release-files.ts"
import { createTarGz } from "./tar.ts"

export interface BinaryBuild {
  readonly buildScript: string
  readonly version: string
  readonly releaseUrl: string
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

const adHocSign = (binary: string, target: Target) =>
  target.os === "darwin" && process.platform === "darwin" ? run("codesign", ["--sign", "-", "--force", binary]) : Effect.void

export const buildBinaries = (build: BinaryBuild) =>
  Effect.gen(function*() {
    const binaries = join(build.outDirectory, "binaries")
    const sidecars = join(build.outDirectory, "sidecars")
    yield* Effect.sync(() => {
      mkdirSync(build.outDirectory, { recursive: true })
      mkdirSync(sidecars, { recursive: true })
    })
    return yield* Effect.forEach(build.targets, (target) =>
      Effect.gen(function*() {
        const directory = join(binaries, platformOf(target))
        yield* Effect.sync(() => mkdirSync(directory, { recursive: true }))
        const binary = join(directory, "exangelos")
        yield* run(bun, [
          build.buildScript,
          `--target=${target.bunTarget}`,
          "--version",
          build.version,
          "--official-plugins",
          JSON.stringify(build.officialPlugins),
          "--release-url",
          build.releaseUrl,
          "--outfile",
          binary
        ])
        yield* adHocSign(binary, target)
        const archive = join(build.outDirectory, binaryArchiveName(build.version, target))
        yield* createTarGz(archive, directory, ["exangelos"])
        const sidecar = join(sidecars, `exangelos-${target.rustTriple}`)
        yield* Effect.sync(() => copyFileSync(binary, sidecar))
        const built: BuiltBinary = { target, binary, archive, sidecar }
        return built
      }))
  })
