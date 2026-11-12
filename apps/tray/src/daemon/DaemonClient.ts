import { DaemonContract, SessionHeaders } from "@exangelos/contracts"
import { type Alert, type Plugin, PluginRules, type Subscription } from "@exangelos/domain"
import { Context, Effect, Layer, Option, Predicate, Result, Schema } from "effect"
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

const describeDefect = (defect: unknown): string => {
  if (Predicate.hasProperty(defect, "message") && typeof defect.message === "string" && defect.message !== "") {
    return defect.message
  }
  if (Predicate.hasProperty(defect, "_tag") && typeof defect._tag === "string") return defect._tag
  if (Predicate.hasProperty(defect, "name") && typeof defect.name === "string") return defect.name
  return String(defect)
}

const section = <A>(
  operation: string,
  call: Effect.Effect<A, RpcClientError>
): Effect.Effect<Section<A>, DaemonNotRunning> =>
  call.pipe(
    Effect.map(Result.succeed),
    Effect.catch((error) =>
      error.reason._tag === "SocketOpenError"
        ? Effect.fail(new DaemonNotRunning({ message: error.message }))
        : Effect.succeed(Result.fail(`${operation}: ${error.message}`))
    ),
    Effect.catchDefect((defect) => Effect.succeed(Result.fail(`${operation}: ${describeDefect(defect)}`)))
  )

/** The trust alert of each plugin. Until the daemon serves `ListPluginAlerts` this derives them from `ListPlugins` without the official checksums, so an inert official plugin raises no alert. */
export const trustAlerts = (
  client: DaemonClient["Service"]
): Effect.Effect<ReadonlyArray<Alert.Alert>, RpcClientError> =>
  Effect.map(
    client.ListPlugins(),
    (plugins) => plugins.flatMap((plugin) => Option.toArray(PluginRules.trustAlert(plugin, Option.some(plugin.digest))))
  )

/** Loads the active subscriptions and every plugin with their trust alerts. A call that fails or that the daemon answers with a defect fails only its own section. Fails with {@link DaemonNotRunning} when the socket cannot be opened. */
export const snapshot: Effect.Effect<Snapshot, DaemonNotRunning, DaemonClient> = Effect.flatMap(
  DaemonClient,
  (client) =>
    Effect.all({
      subscriptions: section("List", client.List({ all: false })),
      plugins: section("ListPlugins", client.ListPlugins()),
      trustAlerts: section("ListPluginAlerts", trustAlerts(client))
    }, { concurrency: "unbounded" })
)
