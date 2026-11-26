import { execFileSync } from "node:child_process"
import { mkdirSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { beforeAll, describe, expect, it } from "@effect/vitest"
import { digestDirectory } from "@exangelos/connector-directory"
import { officialConnectorsFileName, readOfficialConnectors } from "../src/connector-archives.ts"
import { buildRelease, defaultBuildScript, officialConnectorDirectories, type Release } from "../src/release.ts"
import { hostTarget, readChecksums } from "../src/release-files.ts"
import { extractTarGz, listTarGz } from "../src/tar.ts"
import { Effect } from "effect"
import { helloConnectorCopy, runWithRealPrograms, standInBuildScript, temporaryDirectory, withRealPrograms } from "./helpers.ts"

const releaseUrl = "https://example.invalid/releases/download/v9.9.9"

const buildInto = (
  work: string,
  version: string,
  connectorDirectories: ReadonlyArray<string>,
  buildScript = standInBuildScript
): Promise<Release> =>
  runWithRealPrograms(buildRelease({
    buildScript,
    version,
    releaseUrl,
    connectorDirectories,
    officialConnectorsDirectory: join(work, "official-connectors"),
    releaseDirectory: join(work, "release"),
    targets: [hostTarget()]
  }))

describe("release build for this machine (contract test with the real bun, codesign and tar)", () => {
  const work = temporaryDirectory("release")
  let release: Release
  beforeAll(async () => {
    release = await buildInto(work, "9.9.9", [helloConnectorCopy(work)])
  })

  it("compiles a binary that reports the version and carries the release address and connector digests", () => {
    const [built] = release.binaries
    expect(execFileSync(built!.binary, ["--version"], { encoding: "utf8" })).toBe("exangelos 9.9.9\n")
    expect(execFileSync(built!.binary, ["--release-url"], { encoding: "utf8" })).toBe(`${releaseUrl}\n`)
    expect(JSON.parse(execFileSync(built!.binary, ["--official-connectors"], { encoding: "utf8" }))).toEqual(release.officialConnectors)
  })

  it.effect("acts as Bun for a bundled connector when BUN_BE_BUN is set", () =>
    Effect.gen(function*() {
      const [built] = release.binaries
      const unpacked = join(work, "hello")
      mkdirSync(unpacked)
      yield* extractTarGz(join(work, "official-connectors", "hello-1.2.3.tar.gz"), unpacked)
      const output = execFileSync(built!.binary, [join(unpacked, "dist", "index.js")], {
        encoding: "utf8",
        env: { ...process.env, BUN_BE_BUN: "1" }
      })
      expect(output).toBe("hello connector\n")
    }).pipe(withRealPrograms))

  it.effect("archives the binary alone and lists every release file in SHA256SUMS", () =>
    Effect.gen(function*() {
      const archive = `exangelos-9.9.9-${hostTarget().os}-${hostTarget().arch}.tar.gz`
      expect(yield* listTarGz(join(work, "release", archive))).toEqual(["exangelos"])
      expect(readChecksums(join(work, "release")).map((line) => line.file)).toEqual(
        [archive, "hello-1.2.3.tar.gz", officialConnectorsFileName].toSorted()
      )
      expect(readOfficialConnectors(join(work, "release", officialConnectorsFileName))).toEqual(release.officialConnectors)
    }).pipe(withRealPrograms))
})

describe("rebuilding a release directory (contract test with the real bun and tar)", () => {
  it("drops archives from an earlier build so SHA256SUMS covers every release file", async () => {
    const work = temporaryDirectory("rebuild")
    await buildInto(work, "1.0.0", [])
    await buildInto(work, "1.0.1", [])
    const files = readdirSync(join(work, "release")).filter((name) => name.endsWith(".tar.gz") || name === officialConnectorsFileName)
    expect(files).toEqual(readChecksums(join(work, "release")).map((line) => line.file))
  })
})

describe("official release for this machine (contract test with the real CLI build and the official connectors)", () => {
  const work = temporaryDirectory("official")
  let release: Release
  beforeAll(async () => {
    release = await buildInto(work, "9.9.9", officialConnectorDirectories(), defaultBuildScript)
  }, 300_000)

  it("ships github-pr, github-repo, jira, file-watch, slack and teams", () => {
    expect(release.officialConnectors.map((connector) => connector.name)).toEqual([
      "github-pr",
      "github-repo",
      "jira",
      "file-watch",
      "slack",
      "teams"
    ])
  })

  it.effect("records in official-connectors.json the digest of each unpacked archive", () =>
    Effect.gen(function*() {
      const listed = readOfficialConnectors(join(work, "release", officialConnectorsFileName))
      expect(listed).toEqual(release.officialConnectors)
      for (const connector of listed) {
        const unpacked = join(work, `unpacked-${connector.name}`)
        mkdirSync(unpacked)
        yield* extractTarGz(join(work, "release", `${connector.name}-${connector.version}.tar.gz`), unpacked)
        expect(yield* digestDirectory(unpacked), connector.name).toBe(connector.digest)
      }
    }).pipe(withRealPrograms))

  it("compiles the release address and every official connector's digest into the binary", () => {
    const [built] = release.binaries
    const bytes = readFileSync(built!.binary)
    expect(bytes.includes(releaseUrl), releaseUrl).toBe(true)
    for (const connector of release.officialConnectors) {
      expect(bytes.includes(connector.digest), connector.name).toBe(true)
    }
  })
})
