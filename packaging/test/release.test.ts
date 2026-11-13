import { execFileSync } from "node:child_process"
import { mkdirSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { beforeAll, describe, expect, it } from "@effect/vitest"
import { digestDirectory } from "@exangelos/plugin-directory"
import { officialPluginsFileName, readOfficialPlugins } from "../src/plugin-archives.ts"
import { buildRelease, defaultBuildScript, officialPluginDirectories, type Release } from "../src/release.ts"
import { hostTarget, readChecksums } from "../src/release-files.ts"
import { extractTarGz, listTarGz } from "../src/tar.ts"
import { Effect } from "effect"
import { helloPlugin, runWithRealPrograms, standInBuildScript, temporaryDirectory, withRealPrograms } from "./helpers.ts"

const releaseUrl = "https://example.invalid/releases/download/v9.9.9"

const buildInto = (
  work: string,
  version: string,
  pluginDirectories: ReadonlyArray<string>,
  buildScript = standInBuildScript
): Promise<Release> =>
  runWithRealPrograms(buildRelease({
    buildScript,
    version,
    releaseUrl,
    pluginDirectories,
    officialPluginsDirectory: join(work, "official-plugins"),
    releaseDirectory: join(work, "release"),
    targets: [hostTarget()]
  }))

describe("release build for this machine (contract test with the real bun, codesign and tar)", () => {
  const work = temporaryDirectory("release")
  let release: Release
  beforeAll(async () => {
    release = await buildInto(work, "9.9.9", [helloPlugin])
  })

  it("compiles a binary that reports the version and carries the release address and plugin digests", () => {
    const [built] = release.binaries
    expect(execFileSync(built!.binary, ["--version"], { encoding: "utf8" })).toBe("exangelos 9.9.9\n")
    expect(execFileSync(built!.binary, ["--release-url"], { encoding: "utf8" })).toBe(`${releaseUrl}\n`)
    expect(JSON.parse(execFileSync(built!.binary, ["--official-plugins"], { encoding: "utf8" }))).toEqual(release.officialPlugins)
  })

  it.effect("acts as Bun for a bundled plugin when BUN_BE_BUN is set", () =>
    Effect.gen(function*() {
      const [built] = release.binaries
      const unpacked = join(work, "hello")
      mkdirSync(unpacked)
      yield* extractTarGz(join(work, "official-plugins", "hello-1.2.3.tar.gz"), unpacked)
      const output = execFileSync(built!.binary, [join(unpacked, "dist", "index.js")], {
        encoding: "utf8",
        env: { ...process.env, BUN_BE_BUN: "1" }
      })
      expect(output).toBe("hello plugin\n")
    }).pipe(withRealPrograms))

  it.effect("archives the binary alone and lists every release file in SHA256SUMS", () =>
    Effect.gen(function*() {
      const archive = `exangelos-9.9.9-${hostTarget().os}-${hostTarget().arch}.tar.gz`
      expect(yield* listTarGz(join(work, "release", archive))).toEqual(["exangelos"])
      expect(readChecksums(join(work, "release")).map((line) => line.file)).toEqual(
        [archive, "hello-1.2.3.tar.gz", officialPluginsFileName].toSorted()
      )
      expect(readOfficialPlugins(join(work, "release", officialPluginsFileName))).toEqual(release.officialPlugins)
    }).pipe(withRealPrograms))
})

describe("rebuilding a release directory (contract test with the real bun and tar)", () => {
  it("drops archives from an earlier build so SHA256SUMS covers every release file", async () => {
    const work = temporaryDirectory("rebuild")
    await buildInto(work, "1.0.0", [])
    await buildInto(work, "1.0.1", [])
    const files = readdirSync(join(work, "release")).filter((name) => name.endsWith(".tar.gz") || name === officialPluginsFileName)
    expect(files).toEqual(readChecksums(join(work, "release")).map((line) => line.file))
  })
})

describe("official release for this machine (contract test with the real CLI build and the official plugins)", () => {
  const work = temporaryDirectory("official")
  let release: Release
  beforeAll(async () => {
    release = await buildInto(work, "9.9.9", officialPluginDirectories(), defaultBuildScript)
  }, 300_000)

  it("ships github-pr, jira and file-watch", () => {
    expect(release.officialPlugins.map((plugin) => plugin.name)).toEqual(["github-pr", "jira", "file-watch"])
  })

  it.effect("records in official-plugins.json the digest of each unpacked archive", () =>
    Effect.gen(function*() {
      const listed = readOfficialPlugins(join(work, "release", officialPluginsFileName))
      expect(listed).toEqual(release.officialPlugins)
      for (const plugin of listed) {
        const unpacked = join(work, `unpacked-${plugin.name}`)
        mkdirSync(unpacked)
        yield* extractTarGz(join(work, "release", `${plugin.name}-${plugin.version}.tar.gz`), unpacked)
        expect(yield* digestDirectory(unpacked), plugin.name).toBe(plugin.digest)
      }
    }).pipe(withRealPrograms))

  it("compiles the release address and every official plugin's digest into the binary", () => {
    const [built] = release.binaries
    const bytes = readFileSync(built!.binary)
    expect(bytes.includes(releaseUrl), releaseUrl).toBe(true)
    for (const plugin of release.officialPlugins) {
      expect(bytes.includes(plugin.digest), plugin.name).toBe(true)
    }
  })
})
