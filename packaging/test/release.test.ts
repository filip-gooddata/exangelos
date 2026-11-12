import { execFileSync } from "node:child_process"
import { describe, expect, it } from "vitest"
import { readdirSync } from "node:fs"
import { join } from "node:path"
import { listTarGz } from "../src/tar.ts"
import { buildRelease } from "../src/release.ts"
import { hostTarget, readChecksums } from "../src/release-files.ts"
import { helloPlugin, standInEntry, temporaryDirectory } from "./helpers.ts"

describe("release build for this machine", () => {
  const work = temporaryDirectory("release")
  const release = buildRelease({
    entry: standInEntry,
    version: "9.9.9",
    pluginDirectories: [helloPlugin],
    officialPluginsDirectory: join(work, "official-plugins"),
    releaseDirectory: join(work, "release"),
    targets: [hostTarget()]
  })
  const [built] = release.binaries

  it("compiles a binary that reports the version and carries the plugin digests", () => {
    expect(execFileSync(built!.binary, ["--version"], { encoding: "utf8" })).toBe("exangelos 9.9.9\n")
    expect(JSON.parse(execFileSync(built!.binary, ["--official-plugins"], { encoding: "utf8" }))).toEqual(release.officialPlugins)
  })

  it("archives the binary alone and lists every release file in SHA256SUMS", () => {
    const archive = `exangelos-9.9.9-${hostTarget().os}-${hostTarget().arch}.tar.gz`
    expect(listTarGz(join(work, "release", archive))).toEqual(["exangelos"])
    expect(readChecksums(join(work, "release")).map((line) => line.file)).toEqual([archive, "hello-1.2.3.tar.gz"].toSorted())
  })
})

describe("rebuilding a release directory", () => {
  it("drops archives from an earlier build so SHA256SUMS covers every archive", () => {
    const work = temporaryDirectory("rebuild")
    const build = (version: string) =>
      buildRelease({
        entry: standInEntry,
        version,
        pluginDirectories: [],
        officialPluginsDirectory: join(work, "official-plugins"),
        releaseDirectory: join(work, "release"),
        targets: [hostTarget()]
      })
    build("1.0.0")
    build("1.0.1")
    const archives = readdirSync(join(work, "release")).filter((name) => name.endsWith(".tar.gz"))
    expect(archives).toEqual(readChecksums(join(work, "release")).map((line) => line.file))
  })
})
