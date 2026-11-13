import { spawnSync } from "node:child_process"
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { beforeAll, describe, expect, it } from "@effect/vitest"
import { buildRelease, packagingDirectory } from "../src/release.ts"
import { hostTarget } from "../src/release-files.ts"
import { runWithRealPrograms, standInBuildScript, temporaryDirectory } from "./helpers.ts"

const installScript = join(packagingDirectory, "install.sh")

describe("install script (contract test with the real bun, tar and sh)", () => {
  const work = temporaryDirectory("install")
  const releaseDirectory = join(work, "release")
  beforeAll(() =>
    runWithRealPrograms(buildRelease({
      buildScript: standInBuildScript,
      version: "9.9.9",
      releaseUrl: "https://example.invalid/releases/download/v9.9.9",
      pluginDirectories: [],
      officialPluginsDirectory: join(work, "official-plugins"),
      releaseDirectory,
      targets: [hostTarget()]
    }))
  )

  const install = (release: string, installDirectory: string) =>
    spawnSync("sh", [installScript], {
      encoding: "utf8",
      env: { PATH: process.env["PATH"], HOME: join(work, "home"), EXANGELOS_RELEASE: release, EXANGELOS_INSTALL_DIR: installDirectory }
    })

  it("installs exangelos and the xng alias from a local folder", () => {
    const installDirectory = join(work, "bin")
    const result = install(releaseDirectory, installDirectory)
    expect(result.stderr).toBe("")
    expect(result.status).toBe(0)
    expect(readlinkSync(join(installDirectory, "xng"))).toBe("exangelos")
    const run = spawnSync(join(installDirectory, "xng"), ["--version"], { encoding: "utf8" })
    expect(run.stdout).toBe("exangelos 9.9.9\n")
  })

  it("accepts a file:// URL", () => {
    expect(install(`file://${releaseDirectory}`, join(work, "bin-url")).status).toBe(0)
  })

  it("refuses an archive whose checksum does not match and installs nothing", () => {
    const tampered = join(work, "tampered")
    cpSync(releaseDirectory, tampered, { recursive: true })
    const sums = join(tampered, "SHA256SUMS")
    writeFileSync(sums, readFileSync(sums, "utf8").replace(/^[0-9a-f]{64}/gm, "0".repeat(64)))
    const installDirectory = join(work, "bin-tampered")
    const result = install(tampered, installDirectory)
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("checksum mismatch")
    expect(existsSync(installDirectory)).toBe(false)
  })
  it("refuses a Linux system without glibc and installs nothing", () => {
    const fakeBin = join(work, "musl-bin")
    mkdirSync(fakeBin)
    writeFileSync(join(fakeBin, "uname"), '#!/bin/sh\n[ "$1" = -m ] && echo x86_64 || echo Linux\n')
    writeFileSync(join(fakeBin, "getconf"), "#!/bin/sh\nexit 1\n")
    chmodSync(join(fakeBin, "uname"), 0o755)
    chmodSync(join(fakeBin, "getconf"), 0o755)
    const installDirectory = join(work, "bin-musl")
    const result = spawnSync("sh", [installScript], {
      encoding: "utf8",
      env: {
        PATH: `${fakeBin}:${process.env["PATH"]}`,
        HOME: join(work, "home"),
        EXANGELOS_RELEASE: releaseDirectory,
        EXANGELOS_INSTALL_DIR: installDirectory
      }
    })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("needs glibc")
    expect(existsSync(installDirectory)).toBe(false)
  })
})
