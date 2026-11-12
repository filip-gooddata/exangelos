import { Effect, FileSystem, Option } from "effect"
import type { PlatformError } from "effect/PlatformError"
import type { FileGlob } from "./FileGlob.ts"
import * as OpenDirectory from "./OpenDirectory.ts"

/** What the plugin remembers of a file to tell a change. */
export interface Fingerprint {
  readonly modifiedAt: number
  readonly size: number
  readonly bornAt: number | undefined
}

/** Matching files by path relative to the base directory. */
export type Snapshot = ReadonlyMap<string, Fingerprint>

const fingerprint = (info: FileSystem.File.Info): Fingerprint => ({
  modifiedAt: Option.match(info.mtime, { onNone: () => 0, onSome: (date) => date.getTime() }),
  size: Number(info.size),
  bornAt: Option.match(info.birthtime, {
    onNone: () => undefined,
    onSome: (date) => date.getTime() > 0 ? date.getTime() : undefined
  })
})

const join = (directory: string, name: string) => directory === "" ? name : `${directory}/${name}`

const ifMissing = <A>(fallback: A) => (error: PlatformError) =>
  error.reason._tag === "NotFound" ? Effect.succeed(fallback) : Effect.fail(error)

const lstat = (fs: FileSystem.FileSystem, path: string) =>
  fs.lstat(path).pipe(Effect.asSome, Effect.catch(ifMissing(Option.none<FileSystem.File.Info>())))

const walk = (
  fs: FileSystem.FileSystem,
  glob: FileGlob,
  directory: OpenDirectory.OpenDirectory,
  relative: string,
  into: Map<string, Fingerprint>
): Effect.Effect<void, PlatformError> =>
  Effect.gen(function*() {
    const names = yield* fs.readDirectory(directory.path).pipe(Effect.catch(ifMissing<Array<string>>([])))
    const depth = relative === "" ? 0 : relative.split("/").length
    const directories: Array<string> = []
    for (const name of names) {
      const path = join(relative, name)
      if (glob.ignores(path)) continue
      const info = yield* lstat(fs, `${directory.path}/${name}`)
      if (Option.isNone(info)) continue
      if (info.value.type === "Directory" && depth + 1 < glob.depth) directories.push(name)
      if (info.value.type === "File" && glob.includes(path)) into.set(path, fingerprint(info.value))
    }
    for (const name of directories) {
      yield* Effect.scoped(
        Effect.gen(function*() {
          const opened = yield* OpenDirectory.child(directory, name)
          if (Option.isSome(opened)) yield* walk(fs, glob, opened.value, join(relative, name), into)
        })
      )
    }
  })

/**
 * Whether the base directory exists as a directory. The base itself may be a
 * symbolic link, since the user named it; nothing below it is followed.
 * Errors other than a missing path fail, so they never read as deletions.
 */
export const baseExists = (glob: FileGlob) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const info = yield* lstat(fs, glob.base)
    if (Option.isSome(info) && info.value.type === "Directory") return true
    const followed = yield* fs.stat(glob.base).pipe(
      Effect.asSome,
      Effect.catch(ifMissing(Option.none<FileSystem.File.Info>()))
    )
    return Option.isSome(followed) && followed.value.type === "Directory"
  })

/** Every matching file below the base directory. Symbolic links are never followed. */
export const scan = (glob: FileGlob) => observe(glob, "")

const isName = (segment: string) => segment !== "" && segment !== "." && segment !== ".." && !segment.includes("\0")

/**
 * The matching files at or below one relative path. Each directory on the way
 * is opened without following a symbolic link and then read through its
 * identity, so nothing reached through a symbolic link below the base
 * directory is recorded, however a swap is timed.
 */
export const observe = (glob: FileGlob, relative: string) =>
  Effect.scoped(Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const found = new Map<string, Fingerprint>()
    if (!(yield* baseExists(glob))) return found as Snapshot
    let directory = yield* OpenDirectory.base(yield* fs.realPath(glob.base))
    if (relative === "") {
      yield* walk(fs, glob, directory, "", found)
      return found as Snapshot
    }
    const segments = relative.split("/")
    if (!segments.every(isName)) return found as Snapshot
    for (let index = 1; index <= segments.length; index++) {
      const path = segments.slice(0, index).join("/")
      const name = segments[index - 1]!
      if (glob.ignores(path)) return found as Snapshot
      const info = yield* lstat(fs, `${directory.path}/${name}`)
      if (Option.isNone(info)) return found as Snapshot
      if (index === segments.length) {
        if (info.value.type === "File" && glob.includes(path)) found.set(path, fingerprint(info.value))
        if (info.value.type !== "Directory" || index >= glob.depth) return found as Snapshot
      } else if (info.value.type !== "Directory") return found as Snapshot
      const opened = yield* OpenDirectory.child(directory, name)
      if (Option.isNone(opened)) return found as Snapshot
      if (index === segments.length) yield* walk(fs, glob, opened.value, path, found)
      else directory = opened.value
    }
    return found as Snapshot
  }))
