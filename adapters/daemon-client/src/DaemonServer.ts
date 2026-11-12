import { Paths } from "@exangelos/paths"
import { BunSocketServer } from "@effect/platform-bun"
import { Effect, Layer, Schema } from "effect"
import { RpcSerialization, RpcServer } from "effect/rpc"
import { SocketServer } from "effect/socket"
import { chmod, link, lstat, mkdir, mkdtemp, rm } from "node:fs/promises"
import { dirname } from "node:path"
import { answers } from "./Listener.ts"

export class DaemonAlreadyRunning extends Schema.TaggedError<DaemonAlreadyRunning>()("DaemonAlreadyRunning", {
  path: Schema.String
}) {}

const inode = (path: string) =>
  Effect.promise(() => lstat(path).then((stats) => stats.ino, () => undefined))

const unlinkIfSame = (path: string, ino: number | undefined) =>
  Effect.gen(function*() {
    if (ino !== undefined && (yield* inode(path)) === ino) yield* Effect.promise(() => rm(path, { force: true }))
  })

const linked = (from: string, to: string) =>
  Effect.promise(() =>
    link(from, to).then(
      () => true,
      (error: NodeJS.ErrnoException) => (error.code === "EEXIST" ? false : Promise.reject(error))
    )
  )

const publish = (socket: string, path: string) =>
  Effect.gen(function*() {
    for (const _ of [1, 2]) {
      if (yield* linked(socket, path)) return
      const stale = yield* inode(path)
      if (yield* answers(path)) break
      yield* unlinkIfSame(path, stale)
    }
    return yield* new DaemonAlreadyRunning({ path })
  })

const listen = (path: string) =>
  Effect.gen(function*() {
    yield* Effect.promise(() => mkdir(dirname(path), { recursive: true, mode: 0o700 }))
    const hidden = yield* Effect.acquireRelease(
      Effect.promise(() => mkdtemp(`${dirname(path)}/.`)),
      (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true }))
    )
    const socket = `${hidden}/s`
    const server = yield* BunSocketServer.make({ path: socket })
    yield* Effect.promise(() => chmod(socket, 0o600))
    const own = yield* inode(socket)
    yield* Effect.acquireRelease(publish(socket, path), () => unlinkIfSame(path, own))
    return yield* RpcServer.makeProtocolSocketServer.pipe(Effect.provideService(SocketServer.SocketServer, server))
  }).pipe(Effect.provide(RpcSerialization.layerNdjson))

/** Serves RPC over the unix socket at `path`, replacing a stale socket file and refusing to start beside a live daemon. */
export const layer = (
  path: string
): Layer.Layer<RpcServer.Protocol, DaemonAlreadyRunning | SocketServer.SocketServerError> =>
  Layer.effect(RpcServer.Protocol, listen(path))

/** {@link layer} on the socket path from {@link Paths.Paths}. */
export const layerFromPaths: Layer.Layer<
  RpcServer.Protocol,
  DaemonAlreadyRunning | SocketServer.SocketServerError,
  Paths.Paths
> = Layer.effect(RpcServer.Protocol, Effect.flatMap(Paths.Paths, (paths) => listen(paths.socketPath)))
