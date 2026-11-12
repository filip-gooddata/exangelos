import { execFileSync } from "node:child_process"
import { chmodSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { beforeAll, describe, expect, it } from "@effect/vitest"
import { digestDirectory } from "@exangelos/plugin-directory"
import { Effect } from "effect"
import { buildPluginArchives, type OfficialPlugin, officialPluginsFileName } from "../src/plugin-archives.ts"
import { extractTarGz, listTarGz } from "../src/tar.ts"
import { helloPlugin, temporaryDirectory } from "./helpers.ts"

describe("official plugin archives", () => {
  const work = temporaryDirectory("plugins")
  const out = join(work, "official-plugins")
  let hello: OfficialPlugin | undefined
  beforeAll(async () => {
    ;[hello] = await buildPluginArchives([helloPlugin], out)
  })

  it("puts the manifest and the bundled entry at the archive root", () => {
    expect(listTarGz(join(out, "hello-1.2.3.tar.gz")).toSorted()).toEqual(["dist/index.js", "plugin.json"])
  })

  it("records the digest of the unpacked plugin for the binary to carry", async () => {
    const unpacked = join(work, "unpacked")
    mkdirSync(unpacked)
    extractTarGz(join(out, "hello-1.2.3.tar.gz"), unpacked)
    expect(hello).toEqual({ name: "hello", version: "1.2.3", digest: await Effect.runPromise(digestDirectory(unpacked)) })
    expect(JSON.parse(readFileSync(join(out, officialPluginsFileName), "utf8"))).toEqual([hello])
    expect(execFileSync("bun", [join(unpacked, "dist/index.js")], { encoding: "utf8" })).toBe("hello plugin\n")
  })

  it("writes a SHA256SUMS that shasum accepts", () => {
    expect(execFileSync("shasum", ["-a", "256", "-c", "SHA256SUMS"], { cwd: out, encoding: "utf8" })).toBe("hello-1.2.3.tar.gz: OK\n")
  })
})

describe("plugin digest", () => {
  it.effect("matches a known answer for a tree with a link, an executable and an empty file", () =>
    Effect.gen(function*() {
    const directory = temporaryDirectory("digest-vector")
    mkdirSync(join(directory, "sub"))
    writeFileSync(join(directory, "a"), "one")
    writeFileSync(join(directory, "sub", "b"), "two")
    chmodSync(join(directory, "sub", "b"), 0o755)
    writeFileSync(join(directory, "empty"), "")
    symlinkSync("a", join(directory, "link"))
    expect(yield* digestDirectory(directory)).toBe("fb9c09833e1542198a1594b6f95aed750ec3ceeb5f6ee294fb95a2c203011f42")
  }))

  it.effect("counts content and the execute bit, not timestamps", () =>
    Effect.gen(function*() {
    const directory = temporaryDirectory("digest")
    writeFileSync(join(directory, "a"), "one")
    const first = yield* digestDirectory(directory)
    writeFileSync(join(directory, "a"), "one")
    expect(yield* digestDirectory(directory)).toBe(first)
    chmodSync(join(directory, "a"), 0o755)
    const executable = yield* digestDirectory(directory)
    expect(executable).not.toBe(first)
    writeFileSync(join(directory, "a"), "two")
    expect(yield* digestDirectory(directory)).not.toBe(executable)
  }))
})
