import { Paths } from "@exangelos/paths"
import { BunSocketServer } from "@effect/platform-bun"
import { Cause, Effect, Layer, Schema } from "effect"
import { RpcSerialization, RpcServer } from "effect/rpc"
import { Socket, SocketServer } from "effect/socket"
import { chmod, mkdir, mkdtemp, rename, rm } from "node:fs/promises"
import { dirname } from "node:path"
import { held } from "./Lock.ts"

export class DaemonAlreadyRunning extends Schema.TaggedError<DaemonAlreadyRunning>()("DaemonAlreadyRunning", {
  path: Schema.String
}) {}

/** A client that exits mid-call (a killed `exangelos wait`) breaks its connection: routine, so logged at debug, not as an unhandled error. */
const toleratingDisconnects = (server: SocketServer.SocketServer["Service"]): SocketServer.SocketServer["Service"] => ({
  ...server,
  run: (handler) =>
    server.run((socket) =>
      handler(socket).pipe(
        Effect.catchIf(
          (error): error is typeof error & Socket.SocketError =>
            Socket.isSocketError(error) &&
            (error.reason._tag === "SocketReadError" || error.reason._tag === "SocketWriteError"),
          (error) => Effect.logDebug("client connection broke", Cause.fail(error))
        )
      )
    )
})

const listen = (path: string) =>
  Effect.gen(function*() {
    yield* Effect.promise(() => mkdir(dirname(path), { recursive: true, mode: 0o700 }))
    if (!(yield* held(`${path}.lock`))) return yield* new DaemonAlreadyRunning({ path })
    yield* Effect.promise(() => rm(path, { force: true }))
    const hidden = yield* Effect.acquireRelease(
      Effect.promise(() => mkdtemp(`${dirname(path)}/.`)),
      (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true }))
    )
    const socket = `${hidden}/s`
    const server = yield* BunSocketServer.make({ path: socket })
    yield* Effect.promise(() => chmod(socket, 0o600))
    yield* Effect.acquireRelease(
      Effect.promise(() => rename(socket, path)),
      () => Effect.promise(() => rm(path, { force: true }))
    )
    return yield* RpcServer.makeProtocolSocketServer.pipe(Effect.provideService(SocketServer.SocketServer, toleratingDisconnects(server)))
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
