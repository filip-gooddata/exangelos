import { DaemonContract, SessionHeaders } from "@exangelos/contracts"
import { type Alert, type Plugin, PluginRules, type Subscription } from "@exangelos/domain"
import { Cause, Context, Effect, Layer, Option, Result, Schema } from "effect"
import { RpcClient, RpcSerialization } from "effect/rpc"
import type { RpcClientError } from "effect/rpc/RpcClientError"
import type { Socket } from "effect/socket"

export class DaemonClient extends Context.Service<
  DaemonClient,
  RpcClient.FromGroup<DaemonContract.DaemonContract, RpcClientError>
>()("@exangelos/tray/DaemonClient") {}

const reserved = new Set([SessionHeaders.harnessHeader, SessionHeaders.sessionHeader])

const withoutSession = (headers: ReadonlyArray<[string, string]>) =>
  headers.filter(([name]) => !reserved.has(name.toLowerCase()))

const protocol = Layer.effect(
  RpcClient.Protocol,
  Effect.map(RpcClient.makeProtocolSocket(), (socket) =>
    RpcClient.Protocol.of({
      ...socket,
      send: (clientId, request) =>
        socket.send(
          clientId,
          request._tag === "Request" ? { ...request, headers: withoutSession(request.headers) } : request
        )
    }))
).pipe(Layer.provide(RpcSerialization.layerNdjson))

/** Calls the daemon over `Socket.Socket` with no session headers, so the daemon records you as the actor. */
export const layer: Layer.Layer<DaemonClient, never, Socket.Socket> = Layer.effect(
  DaemonClient,
  RpcClient.make(DaemonContract.DaemonContract)
).pipe(Layer.provide(protocol))

export type Section<A> = Result.Result<A, string>

export interface Snapshot {
  readonly subscriptions: Section<ReadonlyArray<Subscription.Subscription>>
  readonly plugins: Section<ReadonlyArray<Plugin.Plugin>>
  readonly trustAlerts: Section<ReadonlyArray<Alert.Alert>>
}

export class DaemonNotRunning extends Schema.TaggedError<DaemonNotRunning>()("DaemonNotRunning", {
  message: Schema.String
}) {}

export class DaemonUnreachable extends Schema.TaggedError<DaemonUnreachable>()("DaemonUnreachable", {
  message: Schema.String
}) {}

const section = <A>(
  call: Effect.Effect<A, RpcClientError>
): Effect.Effect<Section<A>, DaemonNotRunning | DaemonUnreachable> =>
  call.pipe(
    Effect.map(Result.succeed),
    Effect.mapError((error): DaemonNotRunning | DaemonUnreachable =>
      error.reason._tag === "SocketOpenError"
        ? new DaemonNotRunning({ message: error.message })
        : new DaemonUnreachable({ message: error.message })
    ),
    Effect.catchDefect((defect) => Effect.succeed(Result.fail(Cause.pretty(Cause.die(defect)).split("\n")[0] ?? "")))
  )

/** The trust alert of each plugin. Until the daemon serves `ListPluginAlerts` this derives them from `ListPlugins` without the official checksum, so a disabled official plugin also shows as a checksum mismatch. */
export const trustAlerts = (
  client: DaemonClient["Service"]
): Effect.Effect<ReadonlyArray<Alert.Alert>, RpcClientError> =>
  Effect.map(
    client.ListPlugins(),
    (plugins) => plugins.flatMap((plugin) => Option.toArray(PluginRules.trustAlert(plugin, Option.none())))
  )

/** Loads the active subscriptions and every plugin with their trust alerts. A call the daemon answers with a defect fails only its own section. Fails with {@link DaemonNotRunning} when the socket cannot be opened. */
export const snapshot: Effect.Effect<Snapshot, DaemonNotRunning | DaemonUnreachable, DaemonClient> = Effect.gen(
  function*() {
    const client = yield* DaemonClient
    const subscriptions = yield* section(client.List({ all: false }))
    const plugins = yield* section(client.ListPlugins())
    return { subscriptions, plugins, trustAlerts: yield* section(trustAlerts(client)) }
  }
)
