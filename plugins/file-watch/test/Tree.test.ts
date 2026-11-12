import { describe, expect, it } from "@effect/vitest"
import { Effect, FileSystem, Result } from "effect"
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem"
import { Baseline, FileGlob, Tree } from "@exangelos/plugin-file-watch"

const hourAgo = () => new Date(Date.now() - 3_600_000)

const fixture = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "file-watch-" })
  const write = (path: string, text: string) =>
    Effect.gen(function*() {
      yield* fs.makeDirectory(`${root}/${path.slice(0, path.lastIndexOf("/"))}`, { recursive: true })
      yield* fs.writeFileString(`${root}/${path}`, text)
      yield* fs.utimes(`${root}/${path}`, hourAgo(), hourAgo())
    })
  return { fs, root, write }
})

describe("Tree", () => {
  it.effect("scans matching files and follows no symbolic link", () =>
    Effect.gen(function*() {
      const { fs, root, write } = yield* fixture
      yield* write("dist/main.js", "a")
      yield* write("dist/chunks/one.js", "b")
      yield* write("dist/main.js.map", "c")
      yield* write("outside/secret.js", "d")
      yield* fs.symlink(`${root}/outside`, `${root}/dist/linked`)
      const glob = Result.getOrThrow(FileGlob.parse({ path: `${root}/dist/**/*.js` }, "/home/ada"))

      expect([...(yield* Tree.scan(glob)).keys()].sort()).toEqual(["chunks/one.js", "main.js"])
      expect((yield* Tree.observe(glob, "linked/secret.js")).size).toBe(0)
    }).pipe(Effect.scoped, Effect.provide(BunFileSystem.layer)))

  it.effect("catches up from a cursor on what changed while nothing watched", () =>
    Effect.gen(function*() {
      const { fs, root, write } = yield* fixture
      yield* write("dist/kept.js", "a")
      yield* write("dist/changed.js", "b")
      yield* write("dist/deleted.js", "c")
      const glob = Result.getOrThrow(FileGlob.parse({ path: `${root}/dist/**` }, "/home/ada"))
      const cursor = Baseline.encodeCursor(yield* Tree.scan(glob), Date.now() - 60_000)

      yield* fs.writeFileString(`${root}/dist/changed.js`, "bb")
      yield* fs.remove(`${root}/dist/deleted.js`)
      yield* fs.writeFileString(`${root}/dist/created.js`, "d")
      const changes = Baseline.diff(Baseline.decodeCursor(cursor)!, yield* Tree.scan(glob))

      expect(changes.map(({ path, type }) => [type, path])).toEqual([
        ["file.changed", "changed.js"],
        ["file.created", "created.js"],
        ["file.deleted", "deleted.js"]
      ])
    }).pipe(Effect.scoped, Effect.provide(BunFileSystem.layer)))

  it.effect("fails rather than reading an unreadable directory as empty", () =>
    Effect.gen(function*() {
      const { fs, root, write } = yield* fixture
      yield* write("dist/locked/app.js", "a")
      const glob = Result.getOrThrow(FileGlob.parse({ path: `${root}/dist/**` }, "/home/ada"))
      yield* fs.chmod(`${root}/dist/locked`, 0o000)
      const error = yield* Tree.scan(glob).pipe(Effect.flip)
      yield* fs.chmod(`${root}/dist/locked`, 0o755)

      expect(error.reason._tag).toBe("PermissionDenied")
    }).pipe(Effect.scoped, Effect.provide(BunFileSystem.layer)))

  it.effect("descends without limit for a recursive alternative", () =>
    Effect.gen(function*() {
      const { root, write } = yield* fixture
      yield* write("dist/nested/deep/x.txt", "a")
      const glob = Result.getOrThrow(FileGlob.parse({ path: `${root}/dist/{**,top}/*.txt` }, "/home/ada"))

      expect([...(yield* Tree.scan(glob)).keys()]).toEqual(["nested/deep/x.txt"])
    }).pipe(Effect.scoped, Effect.provide(BunFileSystem.layer)))

  it.effect("discards a directory swapped for a symbolic link while it is read", () =>
    Effect.gen(function*() {
      const { fs, root, write } = yield* fixture
      yield* write("dist/child/inside.txt", "a")
      yield* write("outside/child/secret.txt", "b")
      const swapping = FileSystem.FileSystem.of({
        ...fs,
        readDirectory: (path, options) =>
          path === `${root}/dist/child`
            ? fs.remove(path, { recursive: true }).pipe(
              Effect.andThen(fs.symlink(`${root}/outside/child`, path)),
              Effect.andThen(fs.readDirectory(path, options))
            )
            : fs.readDirectory(path, options)
      })
      const glob = Result.getOrThrow(FileGlob.parse({ path: `${root}/dist/**` }, "/home/ada"))

      expect((yield* Tree.scan(glob).pipe(Effect.provideService(FileSystem.FileSystem, swapping))).size).toBe(0)
    }).pipe(Effect.scoped, Effect.provide(BunFileSystem.layer)))
})
