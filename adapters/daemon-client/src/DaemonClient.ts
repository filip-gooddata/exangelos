import { ServiceManager } from "@exangelos/application"
import { DaemonContract, SessionHeaders } from "@exangelos/contracts"
import type { Session } from "@exangelos/domain"
import { Paths } from "@exangelos/paths"
import { BunSocket } from "@effect/platform-bun"
import { Cause, Context, Duration, Effect, Layer, Option, Schedule, Schema } from "effect"
import { RpcClient, RpcSerialization } from "effect/rpc"
import { Socket } from "effect/socket"
import type { RpcClientError } from "effect/rpc/RpcClientError"
import { answers } from "./Listener.ts"

export class DaemonNotRunning extends Schema.TaggedError<DaemonNotRunning>()("DaemonNotRunning", {
  path: Schema.String,
  reason: Schema.String
}) {}

const reserved = new Set([SessionHeaders.harnessHeader, SessionHeaders.sessionHeader])

export class DaemonClient extends Context.Service<
  DaemonClient,
  RpcClient.FromGroup<DaemonContract.DaemonContract, RpcClientError>
>()("@exangelos/daemon-client/DaemonClient") {}

export interface Options {
  readonly path: string
  readonly session: Option.Option<Session.Session>
}

const startWait = Duration.seconds(10)

const answering = (path: string) =>
  Effect.flatMap(answers(path), (live) =>
    live
      ? Effect.void
      : Effect.fail(
        new DaemonNotRunning({
          path,
          reason: `the service started but nothing answered on ${path} within ${Duration.toSeconds(startWait)}s`
        })
      ))

const started = (path: string): Effect.Effect<void, DaemonNotRunning, ServiceManager.ServiceManager> =>
  Effect.gen(function*() {
    const manager = yield* ServiceManager.ServiceManager
    const status = yield* manager.status
    yield* Effect.logInfo("daemon not answering, starting service").pipe(
      Effect.annotateLogs({ installed: status.installed, running: status.running })
    )
    if (!status.installed) yield* manager.install
    yield* manager.start
  }).pipe(
    Effect.mapError((failure) => new DaemonNotRunning({ path, reason: failure.reason })),
    Effect.andThen(answering(path).pipe(Effect.retry(Schedule.spaced("100 millis").pipe(Schedule.upTo({ duration: startWait }))))),
    Effect.tap(() => Effect.logInfo("daemon answering after service start")),
    Effect.tapError((error) => Effect.logInfo("daemon start failed", Cause.fail(error))),
    Effect.annotateLogs({ target: path })
  )

const connect = ({ path, session }: Options): Layer.Layer<DaemonClient> => {
  const sessionHeaders = Option.match(session, { onNone: () => [], onSome: (s) => Object.entries(SessionHeaders.toHeaders(s)) })
  const withSession = (headers: ReadonlyArray<[string, string]>) => [
    ...headers.filter(([name]) => !reserved.has(name.toLowerCase())),
    ...sessionHeaders
  ]
  const protocol = Layer.effect(
    RpcClient.Protocol,
    Effect.map(RpcClient.makeProtocolSocket(), (socket) =>
      RpcClient.Protocol.of({
        ...socket,
        send: (clientId, request) =>
          socket.send(
            clientId,
            request._tag === "Request" ? { ...request, headers: withSession(request.headers) } : request
          )
      }))
  ).pipe(
    Layer.provide(Layer.effect(Socket.Socket, BunSocket.makeNet({ path }))),
    Layer.provide(RpcSerialization.layerNdjson)
  )
  return Layer.effect(DaemonClient, RpcClient.make(DaemonContract.DaemonContract)).pipe(Layer.provide(protocol))
}

/** Connects to the daemon on the unix socket at `path`; every call carries `session` as headers when present. Fails with {@link DaemonNotRunning} when nothing answers on the socket. */
export const layer = (options: Options): Layer.Layer<DaemonClient, DaemonNotRunning> =>
  Effect.gen(function*() {
    if (!(yield* answers(options.path))) {
      return yield* new DaemonNotRunning({ path: options.path, reason: `nothing answers on ${options.path}` })
    }
    return connect(options)
  }).pipe(Layer.unwrap)

/** {@link layer} that, finding no daemon, installs and starts the service through {@link ServiceManager.ServiceManager} and waits for the socket to answer. A failed start or a socket that stays silent fails with {@link DaemonNotRunning} carrying the reason. */
export const layerStarting = (
  options: Options
): Layer.Layer<DaemonClient, DaemonNotRunning, ServiceManager.ServiceManager> =>
  Effect.gen(function*() {
    if (!(yield* answers(options.path))) yield* started(options.path)
    return connect(options)
  }).pipe(Layer.unwrap)

/** {@link layer} on the socket path from {@link Paths.Paths}. */
export const layerFromPaths = (
  session: Option.Option<Session.Session>
): Layer.Layer<DaemonClient, DaemonNotRunning, Paths.Paths> =>
  Effect.map(Paths.Paths, (paths) => layer({ path: paths.socketPath, session })).pipe(Layer.unwrap)

/** {@link layerStarting} on the socket path from {@link Paths.Paths}. */
export const layerStartingFromPaths = (
  session: Option.Option<Session.Session>
): Layer.Layer<DaemonClient, DaemonNotRunning, Paths.Paths | ServiceManager.ServiceManager> =>
  Effect.map(Paths.Paths, (paths) => layerStarting({ path: paths.socketPath, session })).pipe(Layer.unwrap)
