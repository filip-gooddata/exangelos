import { Effect, FileSystem, Option } from "effect"
import type { PlatformError } from "effect/PlatformError"
import type { FileGlob } from "./FileGlob.ts"

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

const absolute = (glob: FileGlob, relative: string) =>
  relative === "" ? glob.base : glob.base === "/" ? `/${relative}` : `${glob.base}/${relative}`

const ifMissing = <A>(fallback: A) => (error: PlatformError) =>
  error.reason._tag === "NotFound" ? Effect.succeed(fallback) : Effect.fail(error)

const lstat = (fs: FileSystem.FileSystem, path: string) =>
  fs.lstat(path).pipe(Effect.asSome, Effect.catch(ifMissing(Option.none<FileSystem.File.Info>())))

/**
 * Whether a directory below the base still resolves to the same place under
 * the base's real path. Checked after reading the directory, so one that was
 * swapped for a symbolic link while being read is discarded.
 */
const resolvesInside = (fs: FileSystem.FileSystem, glob: FileGlob, realBase: string, relative: string) =>
  fs.realPath(absolute(glob, relative)).pipe(
    Effect.map((real) => real === (relative === "" ? realBase : realBase === "/" ? `/${relative}` : `${realBase}/${relative}`)),
    Effect.catch(ifMissing(false))
  )

const parentOf = (relative: string) => relative.includes("/") ? relative.slice(0, relative.lastIndexOf("/")) : ""

const walk = (
  fs: FileSystem.FileSystem,
  glob: FileGlob,
  realBase: string,
  relative: string,
  into: Map<string, Fingerprint>
): Effect.Effect<void, PlatformError> =>
  Effect.gen(function*() {
    const names = yield* fs.readDirectory(absolute(glob, relative)).pipe(Effect.catch(ifMissing<Array<string>>([])))
    const depth = relative === "" ? 0 : relative.split("/").length
    const files: Array<readonly [string, Fingerprint]> = []
    const directories: Array<string> = []
    for (const name of names) {
      const path = join(relative, name)
      if (glob.ignores(path)) continue
      const info = yield* lstat(fs, absolute(glob, path))
      if (Option.isNone(info)) continue
      if (info.value.type === "Directory" && depth + 1 < glob.depth) directories.push(path)
      if (info.value.type === "File" && glob.includes(path)) files.push([path, fingerprint(info.value)])
    }
    if (!(yield* resolvesInside(fs, glob, realBase, relative))) return
    for (const [path, file] of files) into.set(path, file)
    for (const path of directories) yield* walk(fs, glob, realBase, path, into)
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

/**
 * The matching files at or below one relative path. A path that reaches
 * through a symbolic link below the base directory sees nothing, including a
 * directory swapped for one while it is read. A swap that is undone between
 * the read and the check goes unseen; closing that needs descriptor-relative
 * traversal, which the file system API does not offer.
 */
export const observe = (glob: FileGlob, relative: string) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const found = new Map<string, Fingerprint>()
    if (!(yield* baseExists(glob))) return found as Snapshot
    const realBase = yield* fs.realPath(glob.base)
    if (relative === "") {
      yield* walk(fs, glob, realBase, "", found)
      return found as Snapshot
    }
    const segments = relative.split("/")
    for (let index = 1; index <= segments.length; index++) {
      const path = segments.slice(0, index).join("/")
      if (glob.ignores(path)) return found as Snapshot
      const info = yield* lstat(fs, absolute(glob, path))
      if (Option.isNone(info)) return found as Snapshot
      const last = index === segments.length
      if (!last && info.value.type !== "Directory") return found as Snapshot
      if (last && info.value.type === "File" && glob.includes(path)) {
        if (yield* resolvesInside(fs, glob, realBase, parentOf(path))) found.set(path, fingerprint(info.value))
      }
      if (last && info.value.type === "Directory" && index < glob.depth) yield* walk(fs, glob, realBase, path, found)
    }
    return found as Snapshot
  })
