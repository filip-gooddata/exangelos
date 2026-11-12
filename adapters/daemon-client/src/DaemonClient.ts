import { DaemonContract, SessionHeaders } from "@exangelos/contracts"
import type { Session } from "@exangelos/domain"
import { Paths } from "@exangelos/paths"
import { BunSocket } from "@effect/platform-bun"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { RpcClient, RpcSerialization } from "effect/rpc"
import { Socket } from "effect/socket"
import type { RpcClientError } from "effect/rpc/RpcClientError"
import { answers } from "./Listener.ts"

export class DaemonNotRunning extends Schema.TaggedError<DaemonNotRunning>()("DaemonNotRunning", {
  path: Schema.String
}) {}

export class DaemonClient extends Context.Service<
  DaemonClient,
  RpcClient.FromGroup<DaemonContract.DaemonContract, RpcClientError>
>()("@exangelos/daemon-client/DaemonClient") {}

export interface Options {
  readonly path: string
  readonly session: Option.Option<Session.Session>
}

/** Connects to the daemon on the unix socket at `path`; every call carries `session` as headers when present. Fails with {@link DaemonNotRunning} when nothing answers on the socket. */
export const layer = ({ path, session }: Options): Layer.Layer<DaemonClient, DaemonNotRunning> =>
  Effect.gen(function*() {
    if (!(yield* answers(path))) return yield* new DaemonNotRunning({ path })
    const sessionHeaders = Option.match(session, { onNone: () => [], onSome: (s) => Object.entries(SessionHeaders.toHeaders(s)) })
    const protocol = Layer.effect(
      RpcClient.Protocol,
      Effect.map(RpcClient.makeProtocolSocket(), (socket) =>
        RpcClient.Protocol.of({
          ...socket,
          send: (clientId, request) =>
            socket.send(
              clientId,
              request._tag === "Request" ? { ...request, headers: [...request.headers, ...sessionHeaders] } : request
            )
        }))
    ).pipe(
      Layer.provide(Layer.effect(Socket.Socket, BunSocket.makeNet({ path }))),
      Layer.provide(RpcSerialization.layerNdjson)
    )
    return Layer.effect(DaemonClient, RpcClient.make(DaemonContract.DaemonContract)).pipe(Layer.provide(protocol))
  }).pipe(Layer.unwrap)

/** {@link layer} on the socket path from {@link Paths.Paths}. */
export const layerFromPaths = (
  session: Option.Option<Session.Session>
): Layer.Layer<DaemonClient, DaemonNotRunning, Paths.Paths> =>
  Effect.map(Paths.Paths, (paths) => layer({ path: paths.socketPath, session })).pipe(Layer.unwrap)
