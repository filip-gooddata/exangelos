import { execFileSync } from "node:child_process"
import { chmodSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { beforeAll, describe, expect, it } from "@effect/vitest"
import { digestDirectory } from "@exangelos/connector-directory"
import { limits } from "@exangelos/connector-import"
import { Effect } from "effect"
import { buildConnectorArchive, buildConnectorArchives, type OfficialConnector, officialConnectorsFileName } from "../src/connector-archives.ts"
import { extractTarGz, listTarGz } from "../src/tar.ts"
import { helloConnector, runWithRealPrograms, temporaryDirectory, withRealPrograms } from "./helpers.ts"

describe("official connector archives (contract test with the real bun and tar)", () => {
  const work = temporaryDirectory("connectors")
  const out = join(work, "official-connectors")
  let hello: OfficialConnector | undefined
  beforeAll(async () => {
    ;[hello] = await runWithRealPrograms(buildConnectorArchives([helloConnector], out))
  })

  it.effect("puts the manifest and the bundled entry at the archive root", () =>
    Effect.gen(function*() {
      const listing = yield* listTarGz(join(out, "hello-1.2.3.tar.gz"))
      expect(listing.toSorted()).toEqual(["connector.json", "dist/index.js"])
    }).pipe(withRealPrograms))

  it.effect("records the digest of the unpacked connector for the binary to carry", () =>
    Effect.gen(function*() {
      const unpacked = join(work, "unpacked")
      mkdirSync(unpacked)
      yield* extractTarGz(join(out, "hello-1.2.3.tar.gz"), unpacked)
      expect(hello).toEqual({ name: "hello", version: "1.2.3", digest: yield* digestDirectory(unpacked) })
      expect(JSON.parse(readFileSync(join(out, officialConnectorsFileName), "utf8"))).toEqual([hello])
      expect(execFileSync("bun", [join(unpacked, "dist/index.js")], { encoding: "utf8" })).toBe("hello connector\n")
    }).pipe(withRealPrograms))

  it("writes a SHA256SUMS that shasum accepts", () => {
    expect(execFileSync("shasum", ["-a", "256", "-c", "SHA256SUMS"], { cwd: out, encoding: "utf8" })).toBe("hello-1.2.3.tar.gz: OK\n")
  })
})

const writeConnector = (directory: string, files: ReadonlyArray<string>, build: string, entry = "dist/main.js") => {
  writeFileSync(
    join(directory, "connector.json"),
    JSON.stringify({ name: "extras", version: "0.0.1", entry: { _tag: "Bundle", path: entry }, files })
  )
  writeFileSync(join(directory, "package.json"), JSON.stringify({ name: "extras-fixture", private: true, scripts: { build } }))
}

describe("declared files in a connector archive (contract test with the real bun and tar)", () => {
  const work = temporaryDirectory("extras")
  const connector = join(work, "extras")
  const out = join(work, "out")
  const unpacked = join(work, "unpacked")
  let extras: { readonly digest: string; readonly archive: string } | undefined
  beforeAll(async () => {
    mkdirSync(join(connector, "src"), { recursive: true })
    mkdirSync(join(connector, "runtime", "bin"), { recursive: true })
    mkdirSync(out)
    mkdirSync(unpacked)
    writeConnector(connector, ["runtime", "notes.txt"], "bun build src/main.ts --target=bun --outfile=dist/main.js")
    writeFileSync(
      join(connector, "src", "main.ts"),
      `import { readFileSync } from "node:fs"\nimport { join } from "node:path"\nprocess.stdout.write(readFileSync(join(import.meta.dir, "..", "runtime", "message.txt"), "utf8"))\n`
    )
    writeFileSync(join(connector, "runtime", "message.txt"), "found beside the bundle\n")
    writeFileSync(join(connector, "runtime", "bin", "tool"), "#!/bin/sh\n")
    chmodSync(join(connector, "runtime", "bin", "tool"), 0o755)
    writeFileSync(join(connector, "notes.txt"), "notes")
    writeFileSync(join(connector, "undeclared.txt"), "left out")
    extras = await runWithRealPrograms(buildConnectorArchive(connector, out))
    await runWithRealPrograms(extractTarGz(extras.archive, unpacked))
  })

  it.effect("carries the declared files and folders next to the manifest and the bundle", () =>
    Effect.gen(function*() {
      const listing = yield* listTarGz(join(out, "extras-0.0.1.tar.gz"))
      expect(listing.toSorted()).toEqual([
        "connector.json",
        "dist/main.js",
        "notes.txt",
        "runtime/bin/tool",
        "runtime/message.txt"
      ])
      expect(statSync(join(unpacked, "runtime", "bin", "tool")).mode & 0o111).not.toBe(0)
      expect(execFileSync("bun", [join(unpacked, "dist/main.js")], { encoding: "utf8" })).toBe("found beside the bundle\n")
    }).pipe(withRealPrograms))

  it.effect("covers the declared files in the digest", () =>
    Effect.gen(function*() {
      expect(extras?.digest).toBe(yield* digestDirectory(unpacked))
      writeFileSync(join(unpacked, "runtime", "message.txt"), "changed\n")
      expect(yield* digestDirectory(unpacked)).not.toBe(extras?.digest)
    }))

  it.effect.each([
    ["../outside", "is outside the connector folder"],
    ["missing", "does not exist"],
    ["linked", "is a link"],
    ["linked/main.js", "goes through one"]
  ])("refuses a declared file %s", ([declared, message]) =>
    Effect.gen(function*() {
      const directory = temporaryDirectory("extras-refused")
      mkdirSync(join(directory, "dist"))
      writeFileSync(join(directory, "dist", "main.js"), "")
      symlinkSync("dist", join(directory, "linked"))
      writeConnector(directory, [declared], "true")
      const error = yield* Effect.flip(buildConnectorArchive(directory, directory))
      expect(error._tag).toBe("ConnectorManifestInvalid")
      expect(error.message).toContain(message)
    }).pipe(withRealPrograms))
})

describe("declared files that overlap or overflow", () => {
  const prebuilt = (label: string) => {
    const directory = temporaryDirectory(label)
    mkdirSync(join(directory, "dist"))
    writeFileSync(join(directory, "dist", "main.js"), "")
    return directory
  }

  it.effect("packs the entry once when a listed folder holds it", () =>
    Effect.gen(function*() {
      const directory = prebuilt("extras-overlap")
      writeFileSync(join(directory, "dist", "data.txt"), "data")
      writeConnector(directory, ["dist", "dist/data.txt"], "true", "./dist/main.js")
      const { archive } = yield* buildConnectorArchive(directory, directory)
      const listing = yield* listTarGz(archive)
      expect(listing.length).toBe(3)
      expect(listing).toContain("dist/data.txt")
    }).pipe(withRealPrograms))

  it.effect("refuses an archive with more entries than an import takes", () =>
    Effect.gen(function*() {
      const directory = prebuilt("extras-many")
      for (let index = 0; index <= limits.entries / 2; index++) {
        mkdirSync(join(directory, "assets", `${index}`), { recursive: true })
        writeFileSync(join(directory, "assets", `${index}`, "a"), "")
      }
      writeConnector(directory, ["assets"], "true")
      const error = yield* Effect.flip(buildConnectorArchive(directory, directory))
      expect(error.message).toContain("would be refused on import")
    }).pipe(withRealPrograms))
})

describe("connector digest", () => {
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
