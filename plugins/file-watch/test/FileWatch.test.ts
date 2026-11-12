import { readFileSync } from "node:fs"
import { describe, expect, it } from "@effect/vitest"
import { Duration, Effect, FileSystem, Queue, Schema, Stream } from "effect"
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem"
import { Manifest } from "@exangelos/contracts"
import { PluginTest } from "@exangelos/plugin-sdk"
import { FileWatch } from "@exangelos/plugin-file-watch"

const plugin = FileWatch.make({ home: "/home/ada" })

const client = PluginTest.makeClient(plugin)

describe("file-watch plugin", () => {
  it.effect("hands over a catalogue with three event types and no configuration fields", () =>
    Effect.gen(function*() {
      const { catalogue } = yield* (yield* client).Handshake()

      expect(catalogue.eventTypes.map(({ type }) => type)).toEqual(["file.created", "file.changed", "file.deleted"])
      expect(catalogue.parameters.main).toBe("path")
      expect(catalogue.configuration).toEqual([])
    }).pipe(Effect.scoped, Effect.provide(BunFileSystem.layer)))

  it.effect("describes a glob by its expanded path and refuses a relative or malformed one", () =>
    Effect.gen(function*() {
      const plugin = yield* client

      expect(yield* plugin.Describe({ parameters: { path: "~/code/api-gateway/dist/**", ignore: ["*.map"] } })).toEqual({
        _tag: "Described",
        parameters: { path: "/home/ada/code/api-gateway/dist/**", ignore: ["*.map"] },
        subject: "/home/ada/code/api-gateway/dist/**",
        label: "~/code/api-gateway/dist/**"
      })
      expect((yield* plugin.Describe({ parameters: { path: "dist/**" } }))._tag).toBe("Invalid")
      expect((yield* plugin.Describe({ parameters: { path: "~/code/{api,web/dist/**" } }))._tag).toBe("Invalid")
      expect((yield* plugin.Describe({ parameters: { path: "~/code/**", ignore: ["[ab"] } }))._tag).toBe("Invalid")
    }).pipe(Effect.scoped, Effect.provide(BunFileSystem.layer)))

  it.live("reports files on disk and catches up from its cursor", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "file-watch-" })
      const plugin = yield* client
      const watch = (cursor?: string) =>
        Stream.toQueue(
          plugin.Watch({
            parameters: { path: `${root}/**` },
            eventTypes: [],
            wakeWindow: Duration.millis(300),
            ...(cursor === undefined ? {} : { cursor })
          }),
          { capacity: 64 }
        ).pipe(Effect.map((items) => Queue.take(items).pipe(Effect.timeout(Duration.seconds(5)))))

      const first = yield* Effect.scoped(Effect.gen(function*() {
        const next = yield* watch()
        expect((yield* next)._tag).toBe("Cursor")
        yield* fs.writeFileString(`${root}/build.log`, "started")
        yield* fs.writeFileString(`${root}/build.log`, "started, done")
        return yield* next
      }))
      if (first._tag !== "Event") return expect.unreachable()
      expect(first.event).toMatchObject({
        type: "file.created",
        summary: `Created ${root}/build.log`,
        payload: { path: `${root}/build.log`, size: 13 }
      })
      expect(first.event.dedupeKey).toMatch(new RegExp(`^file\\.created:${root}/build\\.log:\\d+:13$`))

      yield* fs.remove(`${root}/build.log`)
      yield* fs.writeFileString(`${root}/report.txt`, "ok")
      const next = yield* watch(first.cursor)
      const caughtUp = [yield* next, yield* next]
      expect(caughtUp.map((item) => item._tag === "Event" ? [item.event.type, item.event.payload] : item._tag)).toEqual([
        ["file.deleted", { path: `${root}/build.log` }],
        ["file.created", expect.objectContaining({ path: `${root}/report.txt` })]
      ])
    }).pipe(Effect.provide(BunFileSystem.layer)))

  it.live("gathers the writes to one file inside the wake window into one event", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const plugin = yield* client
      const firstEvent = (wakeWindow: Duration.Duration) =>
        Effect.scoped(Effect.gen(function*() {
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "file-watch-" })
          const items = yield* Stream.toQueue(
            plugin.Watch({ parameters: { path: `${root}/**` }, eventTypes: [], wakeWindow }),
            { capacity: 64 }
          )
          const next = Queue.take(items).pipe(Effect.timeout(Duration.seconds(5)))
          yield* next
          yield* fs.writeFileString(`${root}/build.log`, "started")
          yield* Effect.sleep(Duration.millis(800))
          yield* fs.writeFileString(`${root}/build.log`, "started, done")
          const item = yield* next
          return item._tag === "Event" ? item.event.payload : item
        }))

      expect(yield* firstEvent(Duration.millis(300))).toMatchObject({ size: 7 })
      expect(yield* firstEvent(Duration.seconds(2))).toMatchObject({ size: 13 })
    }).pipe(Effect.provide(BunFileSystem.layer)))

  it("declares a manifest that validates and names the bundle the build writes", () => {
    const manifest = Schema.decodeUnknownSync(Manifest.Manifest)(
      JSON.parse(readFileSync(new URL("../plugin.json", import.meta.url), "utf8"))
    )
    const { scripts } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))

    expect(manifest.name).toBe("file-watch")
    expect(manifest.entry).toEqual({ _tag: "Bundle", path: "dist/main.js" })
    expect(scripts.build).toContain("--outfile=dist/main.js")
  })
})
