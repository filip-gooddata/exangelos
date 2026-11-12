import { dlopen, FFIType } from "bun:ffi"
import { Effect } from "effect"
import { open } from "node:fs/promises"

const exclusiveNonBlocking = 2 | 4

const libc = dlopen(process.platform === "darwin" ? "libc.dylib" : "libc.so.6", {
  flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 }
})

export const held = (path: string) =>
  Effect.acquireRelease(
    Effect.promise(() => open(path, "a", 0o600)),
    (handle) => Effect.promise(() => handle.close())
  ).pipe(Effect.map((handle) => libc.symbols.flock(handle.fd, exclusiveNonBlocking) === 0))
