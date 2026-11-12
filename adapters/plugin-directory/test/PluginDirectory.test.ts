import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { layer as fileSystemLayer } from "@effect/platform-bun/BunFileSystem"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Fiber, Layer, type Scope, Stream } from "effect"
import { PluginDirectory } from "@exangelos/application"
import { digestDirectory, layer } from "@exangelos/plugin-directory"

const temporary = Effect.acquireRelease(
  Effect.promise(() => Fs.mkdtemp(Path.join(Os.tmpdir(), "plugin-directory-"))),
  (directory) => Effect.promise(() => Fs.rm(directory, { recursive: true, force: true }))
)

const writePlugin = (directory: string, name: string, bundle = "console.log(1)") =>
  Effect.promise(async () => {
    await Fs.mkdir(Path.join(directory, "dist"), { recursive: true })
    await Fs.writeFile(
      Path.join(directory, "plugin.json"),
      JSON.stringify({ name, version: "1.0.0", entry: { _tag: "Bundle", path: "dist/main.js" } })
    )
    await Fs.writeFile(Path.join(directory, "dist", "main.js"), bundle)
  })

const withDirectory = <A, E>(f: (root: string) => Effect.Effect<A, E, PluginDirectory.PluginDirectory | Scope.Scope>) =>
  Effect.gen(function*() {
    const root = yield* temporary
    return yield* f(root).pipe(Effect.provide(layer({ directory: root }).pipe(Layer.provide(fileSystemLayer))))
  })

describe("PluginDirectory", () => {
  it.live("lists plugins by name and skips one whose manifest is broken", () =>
    withDirectory((root) =>
      Effect.gen(function*() {
        yield* writePlugin(Path.join(root, "template"), "template")
        yield* writePlugin(Path.join(root, "github-pr"), "github-pr")
        yield* Effect.promise(async () => {
          await Fs.mkdir(Path.join(root, "broken"))
          await Fs.writeFile(Path.join(root, "broken", "plugin.json"), "{ not json")
        })
        const directory = yield* PluginDirectory.PluginDirectory

        const plugins = yield* directory.list
        const broken = yield* Effect.flip(directory.read(Path.join(root, "broken")))

        expect(plugins.map((plugin) => [plugin.name, plugin.version])).toEqual([
          ["github-pr", "1.0.0"],
          ["template", "1.0.0"]
        ])
        expect(plugins[1]?.entry).toEqual({ _tag: "Bundle", path: Path.join(root, "template", "dist", "main.js") })
        expect(broken._tag).toBe("ManifestInvalid")
      })
    ).pipe(Effect.scoped))

  it.live("gives the same digest for the same files and another after one byte changes", () =>
    Effect.gen(function*() {
      const root = yield* temporary
      yield* writePlugin(Path.join(root, "a"), "template")
      yield* writePlugin(Path.join(root, "b"), "template")
      const a = yield* digestDirectory(Path.join(root, "a"))
      const b = yield* digestDirectory(Path.join(root, "b"))
      yield* writePlugin(Path.join(root, "b"), "template", "console.log(2)")
      const changed = yield* digestDirectory(Path.join(root, "b"))

      expect(a).toMatch(/^[0-9a-f]{64}$/)
      expect(b).toBe(a)
      expect(changed).not.toBe(a)
    }).pipe(Effect.scoped))

  it.live("reports a change to a plugin's files once they settle", () =>
    withDirectory((root) =>
      Effect.gen(function*() {
        const plugin = Path.join(root, "template")
        yield* writePlugin(plugin, "template")
        const directory = yield* PluginDirectory.PluginDirectory
        const changed = yield* directory.changes(plugin).pipe(Stream.take(1), Stream.runDrain, Effect.forkScoped)
        yield* Effect.sleep("200 millis")

        yield* Effect.promise(() => Fs.writeFile(Path.join(plugin, "dist", "main.js"), "console.log(3)"))

        yield* Fiber.join(changed).pipe(Effect.timeout("5 seconds"))
      })
    ).pipe(Effect.scoped))
})
