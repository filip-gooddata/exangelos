import { DaemonContract } from "@exangelos/contracts"
import type { Plugin, Subscription } from "@exangelos/domain"
import { Context, Effect, Layer, Schema } from "effect"
import { RpcClient, RpcSerialization } from "effect/rpc"
import type { RpcClientError } from "effect/rpc/RpcClientError"
import type { Socket } from "effect/socket"

export class DaemonClient extends Context.Service<
  DaemonClient,
  RpcClient.FromGroup<DaemonContract.DaemonContract, RpcClientError>
>()("@exangelos/tray/DaemonClient") {}

/** Calls the daemon over `Socket.Socket` with no session headers, so the daemon records you as the actor. */
export const layer: Layer.Layer<DaemonClient, never, Socket.Socket> = Layer.effect(
  DaemonClient,
  RpcClient.make(DaemonContract.DaemonContract)
).pipe(
  Layer.provide(RpcClient.layerProtocolSocket()),
  Layer.provide(RpcSerialization.layerNdjson)
)

export interface Snapshot {
  readonly subscriptions: ReadonlyArray<Subscription.Subscription>
  readonly plugins: ReadonlyArray<Plugin.Plugin>
}

export class DaemonNotRunning extends Schema.TaggedError<DaemonNotRunning>()("DaemonNotRunning", {
  message: Schema.String
}) {}

export class DaemonUnreachable extends Schema.TaggedError<DaemonUnreachable>()("DaemonUnreachable", {
  message: Schema.String
}) {}

/** Loads the active subscriptions and every plugin. Fails with {@link DaemonNotRunning} when the socket cannot be opened. */
export const snapshot: Effect.Effect<Snapshot, DaemonNotRunning | DaemonUnreachable, DaemonClient> = Effect.gen(
  function*() {
    const client = yield* DaemonClient
    const [subscriptions, plugins] = yield* Effect.all([client.List({ all: false }), client.ListPlugins()], {
      concurrency: 2
    })
    return { subscriptions, plugins }
  }
).pipe(
  Effect.mapError((error): DaemonNotRunning | DaemonUnreachable =>
    error.reason._tag === "SocketOpenError"
      ? new DaemonNotRunning({ message: error.message })
      : new DaemonUnreachable({ message: error.message })
  )
)
