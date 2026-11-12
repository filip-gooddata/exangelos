import * as NodeFs from "node:fs"
import { Effect, Option, type Scope } from "effect"
import { type PlatformError, systemError } from "effect/PlatformError"

/**
 * A directory held open, with a path that reaches it by identity rather than
 * by name: `/.vol/<device>/<inode>` on macOS, `/proc/self/fd/<fd>` on Linux.
 * Reading or stating through that path stays in the directory that was opened,
 * whatever has since been renamed or swapped for a symbolic link at its name.
 * The path is valid only while the scope that opened it is open.
 */
export interface OpenDirectory {
  readonly path: string
}

const O_NOFOLLOW_ANY = 0x20000000
const O_PATH = 0x200000

const errnoOf = (cause: unknown) =>
  typeof cause === "object" && cause !== null && "code" in cause ? String(cause.code) : undefined

const failure = (method: string, path: string, cause: unknown, description?: string) => {
  const code = errnoOf(cause)
  return systemError({
    _tag: code === "ENOENT"
      ? "NotFound"
      : code === "EACCES" || code === "EPERM"
      ? "PermissionDenied"
      : code === "ELOOP" || code === "ENOTDIR"
      ? "BadResource"
      : "Unknown",
    module: "FileSystem",
    method,
    pathOrDescriptor: path,
    description,
    cause
  })
}

const unsupported = (method: string, path: string) =>
  failure(method, path, undefined, `no descriptor-relative paths on ${process.platform}`)

const open = (path: string, flags: number) =>
  Effect.acquireRelease(
    Effect.try({ try: () => NodeFs.openSync(path, flags), catch: (cause) => failure("open", path, cause) }),
    (fd) => Effect.sync(() => NodeFs.closeSync(fd))
  )

const bind = (fd: number) =>
  Effect.gen(function*() {
    const own = yield* Effect.try({
      try: () => NodeFs.fstatSync(fd, { bigint: true }),
      catch: (cause) => failure("fstat", String(fd), cause)
    })
    const path = process.platform === "darwin" ? `/.vol/${own.dev}/${own.ino}` : `/proc/self/fd/${fd}`
    const reached = Option.liftThrowable(() => NodeFs.statSync(path, { bigint: true }))()
    if (Option.isSome(reached) && reached.value.dev === own.dev && reached.value.ino === own.ino) {
      return Option.some<OpenDirectory>({ path })
    }
    if (own.nlink === 0n) return Option.none<OpenDirectory>()
    return yield* failure("open", path, undefined, "cannot reach an open directory by identity")
  })

const walkFromRoot = (realBase: string) => {
  const flags = O_PATH | NodeFs.constants.O_DIRECTORY | NodeFs.constants.O_NOFOLLOW
  let fd = NodeFs.openSync("/", O_PATH | NodeFs.constants.O_DIRECTORY)
  try {
    for (const name of realBase.split("/").filter((segment) => segment !== "")) {
      const next = NodeFs.openSync(`/proc/self/fd/${fd}/${name}`, flags)
      NodeFs.closeSync(fd)
      fd = next
    }
    return fd
  } catch (cause) {
    NodeFs.closeSync(fd)
    throw cause
  }
}

/**
 * Opens the base directory at its real path. No component may be a symbolic
 * link: macOS refuses one anywhere in the path, and Linux walks from the root
 * one component at a time. Any failure fails, so it never reads as empty.
 */
export const base = (realBase: string): Effect.Effect<OpenDirectory, PlatformError, Scope.Scope> =>
  Effect.gen(function*() {
    if (process.platform === "darwin") {
      const fd = yield* open(realBase, NodeFs.constants.O_RDONLY | NodeFs.constants.O_DIRECTORY | O_NOFOLLOW_ANY)
      const bound = yield* bind(fd)
      if (Option.isSome(bound)) return bound.value
      return yield* failure("open", realBase, undefined, "the base directory was deleted")
    }
    if (process.platform !== "linux") return yield* unsupported("open", realBase)
    const fd = yield* Effect.acquireRelease(
      Effect.try({ try: () => walkFromRoot(realBase), catch: (cause) => failure("open", realBase, cause) }),
      (fd) => Effect.sync(() => NodeFs.closeSync(fd))
    )
    const bound = yield* bind(fd)
    if (Option.isSome(bound)) return bound.value
    return yield* failure("open", realBase, undefined, "the base directory was deleted")
  })

/**
 * Opens a directory inside an open one without following a symbolic link at
 * its name. A name that is gone or is no longer a directory gives none; one
 * that cannot be read fails with PermissionDenied.
 */
export const child = (
  parent: OpenDirectory,
  name: string
): Effect.Effect<Option.Option<OpenDirectory>, PlatformError, Scope.Scope> =>
  open(
    `${parent.path}/${name}`,
    (process.platform === "darwin" ? NodeFs.constants.O_RDONLY : O_PATH) | NodeFs.constants.O_DIRECTORY |
      NodeFs.constants.O_NOFOLLOW
  ).pipe(
    Effect.flatMap(bind),
    Effect.catchIf(
      (error) => error.reason._tag === "NotFound" || error.reason._tag === "BadResource",
      () => Effect.succeed(Option.none<OpenDirectory>())
    )
  )
