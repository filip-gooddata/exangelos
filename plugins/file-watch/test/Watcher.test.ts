import { describe, expect, it } from "@effect/vitest"
import { Duration, Effect, FileSystem, Queue, Result, Stream } from "effect"
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem"
import { FileGlob, Watcher } from "@exangelos/plugin-file-watch"

const settle = Duration.millis(300)

const started = (path: (root: string) => string) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "file-watch-" })
    const glob = Result.getOrThrow(FileGlob.parse({ path: path(root), ignore: ["*.tmp"] }, "/home/ada"))
    const batches = yield* Stream.toQueue(Watcher.watch(glob, undefined, { settle }), { capacity: 64 })
    const next = Queue.take(batches).pipe(
      Effect.timeout(Duration.seconds(5)),
      Effect.map(({ changes }) => changes.map(({ path, type }) => [type, path]))
    )
    return { fs, root, next }
  })

describe("Watcher", () => {
  it.live("reports a burst of writes to one file as one event, then a change and a deletion", () =>
    Effect.gen(function*() {
      const { fs, root, next } = yield* started((root) => `${root}/**`)
      expect(yield* next).toEqual([])

      yield* fs.writeFileString(`${root}/notes.md`, "1")
      yield* fs.writeFileString(`${root}/notes.md`, "12")
      yield* fs.writeFileString(`${root}/notes.md`, "123")
      yield* fs.writeFileString(`${root}/scratch.tmp`, "ignored")
      expect(yield* next).toEqual([["file.created", "notes.md"]])

      yield* fs.writeFileString(`${root}/notes.md`, "1234")
      expect(yield* next).toEqual([["file.changed", "notes.md"]])

      yield* fs.remove(`${root}/notes.md`)
      expect(yield* next).toEqual([["file.deleted", "notes.md"]])
    }).pipe(Effect.provide(BunFileSystem.layer)))

  it.live("waits for a base directory that does not exist yet", () =>
    Effect.gen(function*() {
      const { fs, root, next } = yield* started((root) => `${root}/dist/**`)
      expect(yield* next).toEqual([])

      yield* fs.makeDirectory(`${root}/dist/assets`, { recursive: true })
      yield* fs.writeFileString(`${root}/dist/assets/app.js`, "x")
      expect(yield* next).toEqual([["file.created", "assets/app.js"]])
    }).pipe(Effect.provide(BunFileSystem.layer)))
})
