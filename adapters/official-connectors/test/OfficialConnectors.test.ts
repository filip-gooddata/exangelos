import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import * as Url from "node:url"
import * as BunServices from "@effect/platform-bun/BunServices"
import { describe, expect, it } from "@effect/vitest"
import { Cause, ConfigProvider, Effect, Layer, Logger, References } from "effect"
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

type Options = { folder?: string; served?: Map<string, Uint8Array>; releaseUrl?: string | undefined; redirect?: string; digest?: string }

const fetch = (root: string, name: string, options: Options) =>
  withSource(root, name, options, (source, carried) => source.fetch(carried))

const withSource = <A, E>(
  root: string,
  name: string,
  options: Options,
  use: (source: OfficialConnectorSource.OfficialConnectorSource["Service"], carried: OfficialConnectorSource.Official) => Effect.Effect<A, E>
) => {
  const carried = { ...official(name), ...(options.digest === undefined ? {} : { digest: options.digest }) }
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
        options.redirect !== undefined
          ? new Response(null, { status: 302, headers: { location: options.redirect } })
          : body === undefined
          ? new Response("missing", { status: 404 })
          : new Response(body)
      ))
    })
  )
  const paths = Paths.layer.pipe(Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord({ EXANGELOS_HOME: root }))), Layer.orDie)
  const imports = ConnectorImportLive.layer.pipe(
    Layer.provide(ConnectorDirectoryLive.layer),
    Layer.provide(Layer.mergeAll(BunServices.layer, http, paths))
  )
  return Effect.gen(function*() {
    return yield* use(yield* OfficialConnectorSource.OfficialConnectorSource, carried)
  }).pipe(Effect.provide(OfficialConnectors.layer({ known: [carried], releaseUrl: "releaseUrl" in options ? options.releaseUrl : releaseUrl }).pipe(
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

  it.live("replaces an installed copy only when the digest matches, and can put the earlier copy back", () =>
    Effect.gen(function*() {
      const root = yield* workspace
      const folder = Path.join(root, "dist")
      yield* buildArchive(root, folder)
      const digest = yield* ConnectorDirectoryLive.digestDirectory(Path.join(root, "build", "template"))
      const installed = Path.join(root, "connectors", "template")
      const sentinel = Path.join(installed, "keep.txt")
      yield* Effect.promise(async () => {
        await Fs.mkdir(installed, { recursive: true })
        await Fs.writeFile(sentinel, "installed")
      })
      const exists = (path: string) => Effect.promise(() => Fs.access(path).then(() => true, () => false))

      const refused = yield* Effect.flip(withSource(root, "template", { folder, digest: "sha256-other" }, (s, o) => s.replace(o)))
      expect(refused.reason).toContain("is not the expected sha256-other")
      expect(yield* exists(sentinel)).toBe(true)

      yield* withSource(root, "template", { folder, digest }, (s, o) => s.replace(o))
      expect(yield* exists(Path.join(installed, "connector.json"))).toBe(true)
      expect(yield* exists(sentinel)).toBe(false)
      yield* withSource(root, "template", { folder, digest }, (s, o) => s.restore(o))
      expect(yield* exists(sentinel)).toBe(true)

      yield* withSource(root, "template", { folder, digest }, (s, o) => Effect.andThen(s.replace(o), s.discard(o)))
      expect(yield* Effect.promise(() => Fs.readdir(Path.join(root, "connectors")))).toEqual(["template"])
      yield* withSource(root, "template", { folder, digest }, (s, o) => s.restore(o))
      expect(yield* exists(Path.join(installed, "connector.json"))).toBe(true)

      yield* Effect.promise(() => Fs.rm(installed, { recursive: true, force: true }))
      yield* withSource(root, "template", { folder, digest }, (s, o) => s.replace(o))
      const blocked = yield* Effect.flip(withSource(root, "template", { folder, digest }, (s, o) => s.replace(o)))
      expect(blocked.reason).toContain("is still kept")
      yield* withSource(root, "template", { folder, digest }, (s, o) => s.restore(o))
      expect(yield* Effect.promise(() => Fs.readdir(Path.join(root, "connectors")))).toEqual([])
    }).pipe(Effect.scoped))

  it.live("keeps an install whose swap the legacy-state guard refuses, and its restore leaves it alone", () =>
    Effect.gen(function*() {
      const root = yield* workspace
      const build = Path.join(root, "build", "template")
      const folder = Path.join(root, "dist")
      yield* Effect.promise(async () => {
        await buildTemplate(build)
        const manifest = JSON.parse(await Fs.readFile(Path.join(build, "connector.json"), "utf8"))
        await Fs.writeFile(Path.join(build, "connector.json"), JSON.stringify({ ...manifest, name: "slack" }))
        await Fs.mkdir(folder, { recursive: true })
        await Tar.c({ gzip: true, file: Path.join(folder, "slack-0.1.0.tar.gz"), cwd: build, portable: true }, ["."])
      })
      const digest = yield* ConnectorDirectoryLive.digestDirectory(build)
      const state = Path.join(root, "connectors", "slack", "setup.json")
      yield* Effect.promise(async () => {
        await Fs.mkdir(Path.dirname(state), { recursive: true })
        await Fs.writeFile(state, "private")
      })

      const refused = yield* Effect.flip(withSource(root, "slack", { folder, digest }, (s, o) => s.replace(o)))
      expect(refused.reason).toContain("Slack private state")
      expect(yield* withSource(root, "slack", { folder, digest }, (s, o) => s.kept(o))).toBe(false)
      yield* withSource(root, "slack", { folder, digest }, (s, o) => s.restore(o))
      expect(yield* Effect.promise(() => Fs.readFile(state, "utf8"))).toBe("private")
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

  it.live("logs a release address without its credentials or query", () =>
    Effect.gen(function*() {
      const root = yield* workspace
      const records: Array<string> = []
      const capture = Logger.make(({ cause, fiber, message }) => {
        records.push(JSON.stringify([message, fiber.getRef(References.CurrentLogAnnotations), Cause.pretty(cause)]))
      })
      const addresses = [
        "HTTPS://user:pass@releases.test/v1?tok=sample",
        "HTTPS:releases.test/v1?tok=sample",
        "https://releases.test/v1?label=first sample-tail",
        "https://[?label=sample",
        "https://[?contact=a@b&label=sample",
        "blob:https://user:pass@releases.test/v1"
      ]
      for (const address of addresses) {
        yield* Effect.flip(fetch(root, "jira", { served: new Map(), releaseUrl: address })).pipe(
          Effect.provide(Logger.layer([capture]))
        )
      }
      expect(records.some((record) => record.includes("https://releases.test/v1"))).toBe(true)
      expect(records.filter((record) => /sample|user|pass/.test(record))).toEqual([])
      const failures = records.filter((record) => record.includes("official connector fetch failed"))
      expect(failures).toHaveLength(addresses.length)
      expect(failures.filter((record) => !record.includes("Error"))).toEqual([])
      expect(failures.every((record) => record.includes('"event":"import"'))).toBe(true)
    }).pipe(Effect.scoped))

  it.live("logs a redirect to a malformed address without the address", () =>
    Effect.gen(function*() {
      const root = yield* workspace
      const records: Array<string> = []
      const capture = Logger.make(({ cause, message }) => {
        records.push(JSON.stringify([message, Cause.pretty(cause)]))
      })
      const failed = yield* Effect.flip(fetch(root, "jira", { served: new Map(), redirect: "//[?token=sample" })).pipe(
        Effect.provide(Logger.layer([capture]))
      )
      expect(failed.reason).not.toContain("sample")
      const failures = records.filter((record) => record.includes("official connector fetch failed"))
      expect(failures).toHaveLength(1)
      expect(failures[0]).toContain("OfficialFetchFailed at import")
      expect(failures[0]).toContain("the link redirects to an address that is not a URL")
      expect(records.filter((record) => record.includes("sample"))).toEqual([])
    }).pipe(Effect.scoped))
})
