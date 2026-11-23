import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { layer as fileSystemLayer } from "@effect/platform-bun/BunFileSystem"
import { describe, expect, it } from "@effect/vitest"
import { ConfigProvider, Effect, Fiber, Layer, Option, type Scope, Stream } from "effect"
import { ConnectorDirectory } from "@exangelos/application"
import { Ids } from "@exangelos/domain"
import { Paths } from "@exangelos/paths"
import { digestDirectory, layer } from "@exangelos/connector-directory"
import { buildTemplate } from "./template.ts"

const temporary = Effect.acquireRelease(
  Effect.promise(() => Fs.mkdtemp(Path.join(Os.tmpdir(), "connector-directory-"))),
  (directory) => Effect.promise(() => Fs.rm(directory, { recursive: true, force: true }))
)

const writeConnector = (directory: string, name: string, bundle = "console.log(1)") =>
  Effect.promise(async () => {
    await Fs.mkdir(Path.join(directory, "dist"), { recursive: true })
    await Fs.writeFile(
      Path.join(directory, "connector.json"),
      JSON.stringify({ name, version: "1.0.0", entry: { _tag: "Bundle", path: "dist/main.js" } })
    )
    await Fs.writeFile(Path.join(directory, "dist", "main.js"), bundle)
  })

const withDirectory = <A, E>(f: (root: string) => Effect.Effect<A, E, ConnectorDirectory.ConnectorDirectory | Scope.Scope>) =>
  Effect.gen(function*() {
    const home = yield* temporary
    const root = Path.join(home, "connectors")
    yield* Effect.promise(() => Fs.mkdir(root))
    const paths = Paths.layer.pipe(Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord({ EXANGELOS_HOME: home }))), Layer.orDie)
    return yield* f(root).pipe(Effect.provide(layer.pipe(Layer.provide(Layer.mergeAll(fileSystemLayer, paths)))))
  })

describe("ConnectorDirectory", () => {
  it.live("lists connectors by name and skips one whose manifest is broken", () =>
    withDirectory((root) =>
      Effect.gen(function*() {
        yield* Effect.promise(() => buildTemplate(Path.join(root, "template")))
        yield* writeConnector(Path.join(root, "github-pr"), "github-pr")
        yield* Effect.promise(async () => {
          await Fs.mkdir(Path.join(root, "broken"))
          await Fs.writeFile(Path.join(root, "broken", "connector.json"), "{ not json")
        })
        const directory = yield* ConnectorDirectory.ConnectorDirectory

        const connectors = yield* directory.list
        const broken = yield* Effect.flip(directory.read(Path.join(root, "broken")))

        expect(connectors.map((connector) => [connector.name, connector.version])).toEqual([
          ["github-pr", "1.0.0"],
          ["template", "0.1.0"]
        ])
        expect(connectors[1]?.entry).toEqual({ _tag: "Bundle", path: Path.join(root, "template", "dist", "main.js") })
        expect(broken._tag).toBe("ManifestInvalid")
      })
    ).pipe(Effect.scoped))

  it.live("serves a connector's icon and lists one whose icon is refused without it", () =>
    withDirectory((root) =>
      Effect.gen(function*() {
        yield* Effect.promise(() => buildTemplate(Path.join(root, "template")))
        yield* writeConnector(Path.join(root, "github-pr"), "github-pr")
        yield* Effect.promise(async () => {
          const manifest = Path.join(root, "github-pr", "connector.json")
          const json = JSON.parse(await Fs.readFile(manifest, "utf8")) as object
          await Fs.writeFile(manifest, JSON.stringify({ ...json, icon: "icon.png" }))
          await Fs.writeFile(Path.join(root, "github-pr", "icon.png"), "<svg/>")
        })
        const directory = yield* ConnectorDirectory.ConnectorDirectory

        const connectors = yield* directory.list
        const template = yield* directory.icon(Ids.ConnectorName.make("template"))
        const refused = yield* directory.icon(Ids.ConnectorName.make("github-pr"))

        expect(connectors.map((connector) => connector.name)).toEqual(["github-pr", "template"])
        expect(Option.map(template, (icon) => icon.mediaType)).toEqual(Option.some("image/svg+xml"))
        expect(refused).toEqual(Option.none())
      })
    ).pipe(Effect.scoped))

  it.live("gives the same digest for the same files and another after one byte changes", () =>
    Effect.gen(function*() {
      const root = yield* temporary
      yield* Effect.promise(() => buildTemplate(Path.join(root, "a")))
      yield* Effect.promise(() => buildTemplate(Path.join(root, "b")))
      const a = yield* digestDirectory(Path.join(root, "a"))
      const b = yield* digestDirectory(Path.join(root, "b"))
      yield* Effect.promise(() => Fs.appendFile(Path.join(root, "b", "dist", "main.js"), "\n"))
      const changed = yield* digestDirectory(Path.join(root, "b"))

      expect(a).toMatch(/^[0-9a-f]{64}$/)
      expect(b).toBe(a)
      expect(changed).not.toBe(a)
    }).pipe(Effect.scoped))

  it.live("reports a change to a connector's files once they settle", () =>
    withDirectory((root) =>
      Effect.gen(function*() {
        const connector = Path.join(root, "template")
        yield* Effect.promise(() => buildTemplate(connector))
        const directory = yield* ConnectorDirectory.ConnectorDirectory
        const changed = yield* directory.changes(connector).pipe(Stream.take(1), Stream.runDrain, Effect.forkScoped)
        yield* Effect.sleep("200 millis")

        yield* Effect.promise(() => Fs.writeFile(Path.join(connector, "dist", "main.js"), "console.log(3)"))

        yield* Fiber.join(changed).pipe(Effect.timeout("5 seconds"))
      })
    ).pipe(Effect.scoped))
})
