import { NodeFileSystem, NodePath } from "@effect/platform-node-shared"
import { describe, expect, it } from "@effect/vitest"
import { ConfigProvider, Effect, FileSystem, Layer, Option, Redacted, Sink, Stream } from "effect"
import { ChildProcessSpawner } from "effect/process"
import { SecretStore } from "@exangelos/application"
import { Ids } from "@exangelos/domain"
import { Paths } from "@exangelos/paths"
import { SecretStores } from "../src/index.ts"

const Platform = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)
const github = Ids.ConnectorName.make("github")

const reveal = (secret: Option.Option<Redacted.Redacted<string>>) => Option.map(secret, (value) => Redacted.value(value))

const temporaryFile = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const home = yield* fs.makeTempDirectoryScoped()
  const paths = Paths.layer.pipe(Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord({ EXANGELOS_HOME: home }))))
  return { directory: home, path: `${home}/secrets.json`, paths }
})

const fileStore = <E>(paths: Layer.Layer<Paths.Paths, E>) =>
  SecretStore.SecretStore.pipe(Effect.provide(SecretStores.layerFile.pipe(Layer.provide(paths))))

/** A spawner whose every command exits with `exitCode` and records the program it ran. */
const spawner = (exitCode: number) => {
  const programs: Array<string> = []
  const layer = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, ChildProcessSpawner.make((command) =>
    Effect.sync(() => {
      if (command._tag === "StandardCommand") programs.push(command.command)
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        stdin: Sink.drain,
        stdout: Stream.empty,
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void)
      })
    })
  ))
  return { programs, layer }
}

describe("file store", () => {
  it.effect("stores, reads and deletes secrets", () =>
    Effect.gen(function*() {
      const store = yield* fileStore((yield* temporaryFile).paths)
      expect(yield* store.get(github, "token")).toEqual(Option.none())
      yield* store.set(github, "token", Redacted.make("ghp-one"))
      yield* store.set(github, "webhook", Redacted.make("na obědě\nřádek"))
      expect(reveal(yield* store.get(github, "token"))).toEqual(Option.some("ghp-one"))
      yield* store.delete(github, ["token", "missing"])
      expect(yield* store.get(github, "token")).toEqual(Option.none())
      expect(reveal(yield* store.get(github, "webhook"))).toEqual(Option.some("na obědě\nřádek"))
    }).pipe(Effect.provide(Platform)))

  it.effect("keeps the file at mode 0600 and replaces it through a rename", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const { directory, path, paths } = yield* temporaryFile
      const store = yield* fileStore(paths)
      yield* store.set(github, "token", Redacted.make("ghp-one"))
      const before = yield* fs.stat(path)
      yield* store.set(github, "token", Redacted.make("ghp-two"))
      const after = yield* fs.stat(path)
      expect(after.mode & 0o777).toBe(0o600)
      expect(after.ino).not.toEqual(before.ino)
      expect(yield* fs.readDirectory(directory)).toEqual(["secrets.json"])
    }).pipe(Effect.provide(Platform)))

  it.effect("fails without showing the file's contents when it does not decode", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const { path, paths } = yield* temporaryFile
      const store = yield* fileStore(paths)
      yield* store.set(github, "token", Redacted.make("ghp-one"))
      yield* fs.writeFileString(path, JSON.stringify({ github: { token: 42, other: "ghp-leak" } }))
      const error = yield* Effect.flip(store.get(github, "token"))
      expect(error).toBeInstanceOf(SecretStore.SecretStoreFailed)
      expect(error.connector).toBe(github)
      expect(error.message).not.toContain("ghp-leak")
    }).pipe(Effect.provide(Platform)))
})

describe("file store lookups", () => {
  it.effect("treats inherited object properties as missing entries", () =>
    Effect.gen(function*() {
      const store = yield* fileStore((yield* temporaryFile).paths)
      const constructor = Ids.ConnectorName.make("constructor")
      expect(yield* store.get(constructor, "name")).toEqual(Option.none())
      yield* store.set(github, "token", Redacted.make("ghp-one"))
      expect(yield* store.get(github, "toString")).toEqual(Option.none())
      yield* store.delete(github, ["toString"])
      expect(reveal(yield* store.get(github, "token"))).toEqual(Option.some("ghp-one"))
    }).pipe(Effect.provide(Platform)))

  it.effect("keeps both of two concurrent writes", () =>
    Effect.gen(function*() {
      const store = yield* fileStore((yield* temporaryFile).paths)
      yield* Effect.all([
        store.set(github, "token", Redacted.make("ghp-one")),
        store.set(github, "webhook", Redacted.make("hook"))
      ], { concurrency: "unbounded" })
      expect(reveal(yield* store.get(github, "token"))).toEqual(Option.some("ghp-one"))
      expect(reveal(yield* store.get(github, "webhook"))).toEqual(Option.some("hook"))
    }).pipe(Effect.provide(Platform)))
})

describe("choosing a store", () => {
  const chosen = (platform: string, exitCode: number) => {
    const fake = spawner(exitCode)
    return Effect.gen(function*() {
      const { paths } = yield* temporaryFile
      const store = yield* SecretStore.SecretStore.pipe(
        Effect.provide(SecretStores.layer(platform).pipe(Layer.provide(fake.layer), Layer.provide(paths)))
      )
      yield* store.delete(github, ["token"])
      return fake.programs
    }).pipe(Effect.provide(Platform))
  }

  it.effect("uses the Keychain on macOS", () =>
    Effect.gen(function*() {
      expect(yield* chosen("darwin", 0)).toEqual(["security"])
    }))

  it.effect("uses Secret Service on Linux when secret-tool reaches it", () =>
    Effect.gen(function*() {
      expect(yield* chosen("linux", 1)).toEqual(["secret-tool", "secret-tool"])
    }))

  it.effect("falls back to the file on Linux without Secret Service", () =>
    Effect.gen(function*() {
      expect(yield* chosen("linux", 2)).toEqual(["secret-tool"])
    }))
})
