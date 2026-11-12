import { execFileSync } from "node:child_process"
import { mkdirSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { beforeAll, describe, expect, it } from "@effect/vitest"
import { buildRelease, type Release } from "../src/release.ts"
import { hostTarget, readChecksums } from "../src/release-files.ts"
import { extractTarGz, listTarGz } from "../src/tar.ts"
import { helloPlugin, standInEntry, temporaryDirectory } from "./helpers.ts"

const buildInto = (work: string, version: string, pluginDirectories: ReadonlyArray<string>): Promise<Release> =>
  buildRelease({
    entry: standInEntry,
    version,
    pluginDirectories,
    officialPluginsDirectory: join(work, "official-plugins"),
    releaseDirectory: join(work, "release"),
    targets: [hostTarget()]
  })

describe("release build for this machine", () => {
  const work = temporaryDirectory("release")
  let release: Release
  beforeAll(async () => {
    release = await buildInto(work, "9.9.9", [helloPlugin])
  })

  it("compiles a binary that reports the version and carries the plugin digests", () => {
    const [built] = release.binaries
    expect(execFileSync(built!.binary, ["--version"], { encoding: "utf8" })).toBe("exangelos 9.9.9\n")
    expect(JSON.parse(execFileSync(built!.binary, ["--official-plugins"], { encoding: "utf8" }))).toEqual(release.officialPlugins)
  })

  it("acts as Bun for a bundled plugin when BUN_BE_BUN is set", () => {
    const [built] = release.binaries
    const unpacked = join(work, "hello")
    mkdirSync(unpacked)
    extractTarGz(join(work, "official-plugins", "hello-1.2.3.tar.gz"), unpacked)
    const output = execFileSync(built!.binary, [join(unpacked, "dist", "index.js")], {
      encoding: "utf8",
      env: { ...process.env, BUN_BE_BUN: "1" }
    })
    expect(output).toBe("hello plugin\n")
  })

  it("archives the binary alone and lists every release file in SHA256SUMS", () => {
    const archive = `exangelos-9.9.9-${hostTarget().os}-${hostTarget().arch}.tar.gz`
    expect(listTarGz(join(work, "release", archive))).toEqual(["exangelos"])
    expect(readChecksums(join(work, "release")).map((line) => line.file)).toEqual([archive, "hello-1.2.3.tar.gz"].toSorted())
  })
})

describe("rebuilding a release directory", () => {
  it("drops archives from an earlier build so SHA256SUMS covers every archive", async () => {
    const work = temporaryDirectory("rebuild")
    await buildInto(work, "1.0.0", [])
    await buildInto(work, "1.0.1", [])
    const archives = readdirSync(join(work, "release")).filter((name) => name.endsWith(".tar.gz"))
    expect(archives).toEqual(readChecksums(join(work, "release")).map((line) => line.file))
  })
})
