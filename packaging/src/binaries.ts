import { copyFileSync, mkdirSync } from "node:fs"
import { join, resolve } from "node:path"
import { Effect } from "effect"
import { run } from "./command.ts"
import type { OfficialConnector } from "./connector-archives.ts"
import { bun } from "./connector-archives.ts"
import { binaryArchiveName, platformOf, type Target } from "./release-files.ts"
import { createTarGz } from "./tar.ts"

export interface BinaryBuild {
  readonly buildScript: string
  readonly version: string
  readonly releaseUrl: string
  readonly officialConnectors: ReadonlyArray<OfficialConnector>
  readonly targets: ReadonlyArray<Target>
  readonly outDirectory: string
  readonly signingIdentity?: string | undefined
}

export interface BuiltBinary {
  readonly target: Target
  readonly binary: string
  readonly archive: string
  readonly sidecar: string
}

export const entitlementsFile = resolve(import.meta.dirname, "..", "macos", "entitlements.plist")

// A Developer ID signature turns on the hardened runtime, under which the Bun runtime in the binary needs the JIT
// entitlement. Without an identity the binary gets an ad-hoc signature, which Apple Silicon needs to run it at all.
export const codesignArguments = (binary: string, signingIdentity: string | undefined): ReadonlyArray<string> =>
  signingIdentity === undefined || signingIdentity === ""
    ? ["--sign", "-", "--force", binary]
    : ["--sign", signingIdentity, "--force", "--options", "runtime", "--timestamp", "--entitlements", entitlementsFile, binary]

const sign = (binary: string, target: Target, signingIdentity: string | undefined) =>
  target.os === "darwin" && process.platform === "darwin" ? run("codesign", codesignArguments(binary, signingIdentity)) : Effect.void

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
          "--official-connectors",
          JSON.stringify(build.officialConnectors),
          "--release-url",
          build.releaseUrl,
          "--outfile",
          binary
        ])
        yield* sign(binary, target, build.signingIdentity)
        const archive = join(build.outDirectory, binaryArchiveName(build.version, target))
        yield* createTarGz(archive, directory, ["exangelos"])
        const sidecar = join(sidecars, `exangelos-${target.rustTriple}`)
        yield* Effect.sync(() => copyFileSync(binary, sidecar))
        const built: BuiltBinary = { target, binary, archive, sidecar }
        return built
      }))
  })
