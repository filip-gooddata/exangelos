import { execFileSync } from "node:child_process"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import * as BunServices from "@effect/platform-bun/BunServices"
import { describe, expect, it } from "@effect/vitest"
import { ConfigProvider, Effect, Layer } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { PluginImportSource } from "@exangelos/application"
import { Paths } from "@exangelos/paths"
import * as PluginDirectoryLive from "@exangelos/plugin-directory"
import * as PluginImportLive from "@exangelos/plugin-import"
import { type ArchiveEntry, manifest, pluginEntries, tarGz, zip } from "./fixtures.ts"

const served = new Map<string, Buffer>()

const stubHttp = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request, url) => {
    const body = served.get(url.href)
    return Effect.succeed(HttpClientResponse.fromWeb(
      request,
      body === undefined ? new Response("missing", { status: 404 }) : new Response(new Uint8Array(body))
    ))
  })
)

const pathsIn = (home: string) =>
  Paths.layer.pipe(Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord({ EXANGELOS_HOME: home }))), Layer.orDie)

interface Setup {
  readonly root: string
  readonly plugins: string
}

const setup = Effect.acquireRelease(
  Effect.promise(async (): Promise<Setup> => {
    const root = await Fs.mkdtemp(Path.join(Os.tmpdir(), "plugin-import-"))
    return { root, plugins: Path.join(root, "data", "plugins") }
  }),
  ({ root }) => Effect.promise(() => Fs.rm(root, { recursive: true, force: true }))
)

const place = (setup: Setup, source: PluginImportSource.Source) =>
  Effect.gen(function*() {
    const imports = yield* PluginImportSource.PluginImportSource
    return yield* imports.place(source)
  }).pipe(
    Effect.provide(PluginImportLive.layer.pipe(
      Layer.provide(PluginDirectoryLive.layer),
      Layer.provide(Layer.mergeAll(BunServices.layer, stubHttp, pathsIn(Path.dirname(setup.plugins))))
    ))
  )

const writeFile = (path: string, content: string | Buffer) =>
  Effect.promise(async () => {
    await Fs.mkdir(Path.dirname(path), { recursive: true })
    await Fs.writeFile(path, content)
  })

const listing = (directory: string) =>
  Effect.promise(() => Fs.readdir(directory).then((names) => names.sort(), () => []))

const archiveFile = (setup: Setup, name: string, content: Buffer) =>
  Effect.as(writeFile(Path.join(setup.root, "in", name), content), Path.join(setup.root, "in", name))

describe("PluginImportSource", () => {
  it.live("places a tar.gz archive under the plugin's name, inside one wrapper directory", () =>
    Effect.gen(function*() {
      const s = yield* setup
      const archive = yield* archiveFile(s, "a.tar.gz", tarGz([
        { path: "template-1.0.0/", type: "directory" },
        ...pluginEntries("template", "template-1.0.0/")
      ]))

      const directory = yield* place(s, { _tag: "ArchiveFile", path: archive })

      expect(directory).toBe(Path.join(s.plugins, "template"))
      expect(yield* listing(directory)).toEqual(["main.js", "plugin.json"])
      expect(yield* listing(Path.dirname(s.plugins))).toEqual(["plugins"])
    }).pipe(Effect.scoped))

  it.live("places a zip from an https link and replaces the earlier copy", () =>
    Effect.gen(function*() {
      const s = yield* setup
      yield* writeFile(Path.join(s.plugins, "template", "stale.js"), "old")
      served.set("https://releases.test/final.zip", zip(pluginEntries("template")))

      const directory = yield* place(s, { _tag: "HttpsLink", url: "https://releases.test/final.zip" })

      expect(yield* listing(directory)).toEqual(["main.js", "plugin.json"])
    }).pipe(Effect.scoped))

  it.live("copies a local directory without its .git", () =>
    Effect.gen(function*() {
      const s = yield* setup
      const source = Path.join(s.root, "work", "my-plugin")
      yield* writeFile(Path.join(source, "plugin.json"), manifest("local-one"))
      yield* writeFile(Path.join(source, "main.js"), "1")
      yield* writeFile(Path.join(source, ".git", "HEAD"), "ref: refs/heads/main")

      const directory = yield* place(s, { _tag: "Directory", path: source })

      expect(directory).toBe(Path.join(s.plugins, "local-one"))
      expect(yield* listing(directory)).toEqual(["main.js", "plugin.json"])
    }).pipe(Effect.scoped))

  it.live("checks out a git repository at a tag and drops .git", () =>
    Effect.gen(function*() {
      const s = yield* setup
      const repository = Path.join(s.root, "repo")
      yield* writeFile(Path.join(repository, "plugin.json"), manifest("from-git"))
      yield* writeFile(Path.join(repository, "main.js"), "1")
      const git = (...args: Array<string>) =>
        execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-C", repository, ...args])
      git("init", "--quiet")
      git("add", ".")
      git("commit", "--quiet", "-m", "one")
      git("tag", "v1")
      yield* writeFile(Path.join(repository, "later.js"), "2")
      git("add", ".")
      git("commit", "--quiet", "-m", "two")

      const directory = yield* place(s, { _tag: "GitRepository", url: repository, ref: "v1" })

      expect(yield* listing(directory)).toEqual(["main.js", "plugin.json"])
    }).pipe(Effect.scoped))

  const refusals: ReadonlyArray<[string, ReadonlyArray<ArchiveEntry>, RegExp]> = [
    ["a .. entry", [...pluginEntries("template"), { path: "../escape.js", content: "x" }], /\.\. segment/],
    ["an absolute path", [...pluginEntries("template"), { path: "/tmp/escape.js", content: "x" }], /absolute path/],
    ["a link that points outside", [
      ...pluginEntries("template"),
      { path: "out", type: "symlink", linkTarget: "../../.." }
    ], /is a link/]
  ]

  for (const [name, entries, reason] of refusals) {
    it.live(`refuses an archive with ${name} and leaves nothing behind`, () =>
      Effect.gen(function*() {
        const s = yield* setup
        const archive = yield* archiveFile(s, "bad.tar.gz", tarGz(entries))

        const failure = yield* Effect.flip(place(s, { _tag: "ArchiveFile", path: archive }))

        expect(failure.reason).toMatch(reason)
        expect(yield* listing(s.plugins)).toEqual([])
        expect(yield* listing(Path.dirname(s.plugins))).toEqual(["plugins"])
      }).pipe(Effect.scoped))
  }
})
