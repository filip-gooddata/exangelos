import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import * as BunServices from "@effect/platform-bun/BunServices"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import * as Tar from "tar"
import { OfficialPluginSource, SettingsStore } from "@exangelos/application"
import { Ids, Settings } from "@exangelos/domain"
import * as OfficialPlugins from "@exangelos/official-plugins"
import * as PluginDirectoryLive from "@exangelos/plugin-directory"
import * as PluginImportLive from "@exangelos/plugin-import"

const releaseUrl = "https://releases.test/v1"
const official = (name: string): OfficialPluginSource.Official => ({
  name: Ids.PluginName.make(name),
  version: "1.0.0",
  digest: "unchecked"
})

const workspace = Effect.acquireRelease(
  Effect.promise(() => Fs.mkdtemp(Path.join(Os.tmpdir(), "official-plugins-"))),
  (root) => Effect.promise(() => Fs.rm(root, { recursive: true, force: true }))
)

/** Writes `<name>-1.0.0.tar.gz` into the folder the way a release build packs it: `plugin.json` at the root. */
const buildArchive = (root: string, folder: string, name: string) =>
  Effect.promise(async () => {
    const files = Path.join(root, "build", name)
    await Fs.mkdir(files, { recursive: true })
    await Fs.writeFile(Path.join(files, "plugin.json"), JSON.stringify({ name, version: "1.0.0", entry: { _tag: "Bundle", path: "main.js" } }))
    await Fs.writeFile(Path.join(files, "main.js"), "console.log(1)")
    await Fs.mkdir(folder, { recursive: true })
    const file = Path.join(folder, `${name}-1.0.0.tar.gz`)
    await Tar.c({ gzip: true, file, cwd: files, portable: true }, ["."])
    return file
  })

const fetch = (root: string, name: string, options: { folder?: string; served?: Map<string, Uint8Array> }) => {
  const plugins = Path.join(root, "plugins")
  const settings = Layer.succeed(SettingsStore.SettingsStore, {
    read: Effect.succeed<Settings.Settings>(
      options.folder === undefined ? Settings.initial : { ...Settings.initial, officialPluginFolder: options.folder }
    ),
    write: () => Effect.void
  })
  const http = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request, url) => {
      const body = options.served?.get(url.href)
      return Effect.succeed(HttpClientResponse.fromWeb(
        request,
        body === undefined ? new Response("missing", { status: 404 }) : new Response(body)
      ))
    })
  )
  const imports = PluginImportLive.layer({ directory: plugins }).pipe(
    Layer.provide(PluginDirectoryLive.layer({ directory: plugins })),
    Layer.provide(Layer.mergeAll(BunServices.layer, http))
  )
  return Effect.gen(function*() {
    const source = yield* OfficialPluginSource.OfficialPluginSource
    return yield* source.fetch(official(name))
  }).pipe(Effect.provide(OfficialPlugins.layer({ known: [official(name)], releaseUrl }).pipe(
    Layer.provide(Layer.mergeAll(settings, imports))
  )))
}

describe("OfficialPluginSource", () => {
  it.live("unpacks an official plugin from the local folder", () =>
    Effect.gen(function*() {
      const root = yield* workspace
      yield* buildArchive(root, Path.join(root, "dist"), "github-pr")

      const directory = yield* fetch(root, "github-pr", { folder: Path.join(root, "dist") })

      expect(directory).toBe(Path.join(root, "plugins", "github-pr"))
      expect((yield* Effect.promise(() => Fs.readdir(directory))).sort()).toEqual(["main.js", "plugin.json"])
    }).pipe(Effect.scoped))

  it.live("downloads an official plugin from the release files", () =>
    Effect.gen(function*() {
      const root = yield* workspace
      const file = yield* buildArchive(root, Path.join(root, "release"), "github-pr")
      const served = new Map([[`${releaseUrl}/github-pr-1.0.0.tar.gz`, new Uint8Array(yield* Effect.promise(() => Fs.readFile(file)))]])

      const directory = yield* fetch(root, "github-pr", { served })

      expect(directory).toBe(Path.join(root, "plugins", "github-pr"))
    }).pipe(Effect.scoped))

  it.live("fails for a plugin missing from the folder or the release", () =>
    Effect.gen(function*() {
      const root = yield* workspace
      yield* Effect.promise(() => Fs.mkdir(Path.join(root, "dist")))

      const local = yield* Effect.flip(fetch(root, "jira", { folder: Path.join(root, "dist") }))
      const release = yield* Effect.flip(fetch(root, "jira", { served: new Map() }))

      expect([local._tag, local.plugin, local.reason]).toEqual(["OfficialFetchFailed", "jira", `jira-1.0.0.tar.gz is not in ${Path.join(root, "dist")}`])
      expect(release.reason).toMatch(/not found/)
    }).pipe(Effect.scoped))
})
