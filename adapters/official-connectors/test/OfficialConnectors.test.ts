import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import * as Url from "node:url"
import * as BunServices from "@effect/platform-bun/BunServices"
import { describe, expect, it } from "@effect/vitest"
import { ConfigProvider, Effect, Layer } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import * as Tar from "tar"
import { OfficialConnectorSource, SettingsStore } from "@exangelos/application"
import { Ids, Settings } from "@exangelos/domain"
import * as OfficialConnectors from "@exangelos/official-connectors"
import { Paths } from "@exangelos/paths"
import * as ConnectorDirectoryLive from "@exangelos/connector-directory"
import * as ConnectorImportLive from "@exangelos/connector-import"
import { buildTemplate } from "./template.ts"

const releaseUrl = "https://releases.test/v1"
const official = (name: string): OfficialConnectorSource.Official => ({
  name: Ids.ConnectorName.make(name),
  version: "0.1.0",
  digest: "unchecked"
})

const workspace = Effect.acquireRelease(
  Effect.promise(() => Fs.mkdtemp(Path.join(Os.tmpdir(), "official-connectors-"))),
  (root) => Effect.promise(() => Fs.rm(root, { recursive: true, force: true }))
)

/** Packs the built template into `template-0.1.0.tar.gz` in the folder the way a release build does: `connector.json` at the root. */
const buildArchive = (root: string, folder: string) =>
  Effect.promise(async () => {
    const files = Path.join(root, "build", "template")
    await buildTemplate(files)
    await Fs.mkdir(folder, { recursive: true })
    const file = Path.join(folder, "template-0.1.0.tar.gz")
    await Tar.c({ gzip: true, file, cwd: files, portable: true }, ["."])
    return file
  })

const fetch = (
  root: string,
  name: string,
  options: { folder?: string; served?: Map<string, Uint8Array>; releaseUrl?: string | undefined }
) => {
  const settings = Layer.succeed(SettingsStore.SettingsStore, {
    read: Effect.succeed<Settings.Settings>(
      options.folder === undefined ? Settings.initial : { ...Settings.initial, officialConnectorFolder: options.folder }
    ),
    write: () => Effect.void,
    update: () => Effect.die("unused")
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
  const paths = Paths.layer.pipe(Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord({ EXANGELOS_HOME: root }))), Layer.orDie)
  const imports = ConnectorImportLive.layer.pipe(
    Layer.provide(ConnectorDirectoryLive.layer),
    Layer.provide(Layer.mergeAll(BunServices.layer, http, paths))
  )
  return Effect.gen(function*() {
    const source = yield* OfficialConnectorSource.OfficialConnectorSource
    return yield* source.fetch(official(name))
  }).pipe(Effect.provide(OfficialConnectors.layer({ known: [official(name)], releaseUrl: "releaseUrl" in options ? options.releaseUrl : releaseUrl }).pipe(
    Layer.provide(Layer.mergeAll(settings, imports))
  )))
}

describe("OfficialConnectorSource", () => {
  it.live("unpacks an official connector from the local folder", () =>
    Effect.gen(function*() {
      const root = yield* workspace
      yield* buildArchive(root, Path.join(root, "dist"))

      const directory = yield* fetch(root, "template", { folder: Path.join(root, "dist") })

      expect(directory).toBe(Path.join(root, "connectors", "template"))
      expect((yield* Effect.promise(() => Fs.readdir(directory))).sort()).toEqual(["connector.json", "dist"])
    }).pipe(Effect.scoped))

  it.live("downloads an official connector from the release files", () =>
    Effect.gen(function*() {
      const root = yield* workspace
      const file = yield* buildArchive(root, Path.join(root, "release"))
      const served = new Map([[`${releaseUrl}/template-0.1.0.tar.gz`, new Uint8Array(yield* Effect.promise(() => Fs.readFile(file)))]])

      const directory = yield* fetch(root, "template", { served })

      expect(directory).toBe(Path.join(root, "connectors", "template"))
    }).pipe(Effect.scoped))

  it.live("reads the release files from a file:// release address", () =>
    Effect.gen(function*() {
      const root = yield* workspace
      yield* buildArchive(root, Path.join(root, "release"))

      const directory = yield* fetch(root, "template", { releaseUrl: Url.pathToFileURL(Path.join(root, "release")).href })

      expect(directory).toBe(Path.join(root, "connectors", "template"))
    }).pipe(Effect.scoped))

  it.live("names the folder setting when the binary carries no release address", () =>
    Effect.gen(function*() {
      const root = yield* workspace

      const error = yield* Effect.flip(fetch(root, "template", { releaseUrl: undefined }))

      expect(error).toMatchObject({ _tag: "OfficialFetchFailed", connector: "template" })
      expect(error.reason).toContain("officialConnectorFolder")
    }).pipe(Effect.scoped))

  it.live("refuses an archive that holds another connector and leaves that connector as it was", () =>
    Effect.gen(function*() {
      const root = yield* workspace
      const folder = Path.join(root, "dist")
      const file = yield* buildArchive(root, folder)
      const sentinel = Path.join(root, "connectors", "template", "keep.txt")
      yield* Effect.promise(async () => {
        await Fs.rename(file, Path.join(folder, "jira-0.1.0.tar.gz"))
        await Fs.mkdir(Path.dirname(sentinel), { recursive: true })
        await Fs.writeFile(sentinel, "installed")
      })

      const failed = yield* Effect.flip(fetch(root, "jira", { folder }))

      expect(failed.reason).toBe("the import holds template, not jira")
      expect(yield* Effect.promise(() => Fs.readFile(sentinel, "utf8"))).toBe("installed")
    }).pipe(Effect.scoped))

  it.live("fails for a connector missing from the folder or the release", () =>
    Effect.gen(function*() {
      const root = yield* workspace
      yield* Effect.promise(() => Fs.mkdir(Path.join(root, "dist")))

      const local = yield* Effect.flip(fetch(root, "jira", { folder: Path.join(root, "dist") }))
      const release = yield* Effect.flip(fetch(root, "jira", { served: new Map() }))

      expect([local._tag, local.connector, local.reason]).toEqual(["OfficialFetchFailed", "jira", `jira-0.1.0.tar.gz is not in ${Path.join(root, "dist")}`])
      expect(release.reason).toMatch(/not found/)
    }).pipe(Effect.scoped))
})
