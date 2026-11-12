import { NodeFileSystem, NodePath } from "@effect/platform-node-shared"
import { describe, expect, it } from "@effect/vitest"
import { Effect, FileSystem, Layer, Option, Redacted } from "effect"
import { SecretsFile } from "../src/index.ts"

const Platform = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)

const secretsPath = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const directory = yield* fs.makeTempDirectoryScoped()
  return `${directory}/data/secrets.json`
})

describe("SecretsFile", () => {
  it.effect("stores, reads and deletes a secret", () =>
    Effect.gen(function*() {
      const path = yield* secretsPath
      expect(yield* SecretsFile.get(path, "github", "token")).toEqual(Option.none())
      yield* SecretsFile.set(path, "github", "token", Redacted.make("ghp-one"))
      yield* SecretsFile.set(path, "github", "webhook", Redacted.make("hook"))
      const token = yield* SecretsFile.get(path, "github", "token")
      expect(Option.map(token, Redacted.value)).toEqual(Option.some("ghp-one"))
      yield* SecretsFile.remove(path, "github", ["token", "missing"])
      expect(yield* SecretsFile.get(path, "github", "token")).toEqual(Option.none())
      expect(Option.map(yield* SecretsFile.get(path, "github", "webhook"), Redacted.value)).toEqual(Option.some("hook"))
    }).pipe(Effect.provide(Platform)))

  it.effect("keeps the file at mode 0600 and replaces it through a rename", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* secretsPath
      yield* SecretsFile.set(path, "github", "token", Redacted.make("ghp-one"))
      const before = yield* fs.stat(path)
      yield* SecretsFile.set(path, "github", "token", Redacted.make("ghp-two"))
      const after = yield* fs.stat(path)
      expect(after.mode & 0o777).toBe(0o600)
      expect(after.ino).not.toEqual(before.ino)
      expect(yield* fs.readDirectory(path.slice(0, path.lastIndexOf("/")))).toEqual(["secrets.json"])
    }).pipe(Effect.provide(Platform)))

  it.effect("names the file but not its contents when it fails to decode", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* secretsPath
      yield* SecretsFile.set(path, "github", "token", Redacted.make("ghp-one"))
      yield* fs.writeFileString(path, JSON.stringify({ github: { token: 42, other: "ghp-leak" } }))
      const error = yield* Effect.flip(SecretsFile.get(path, "github", "token"))
      expect(error.path).toBe(path)
      expect(error.message).not.toContain("ghp-leak")
    }).pipe(Effect.provide(Platform)))
})
