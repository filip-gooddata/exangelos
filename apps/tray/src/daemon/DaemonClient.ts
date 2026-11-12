import { DaemonContract } from "@exangelos/contracts"
import type { Plugin, Subscription } from "@exangelos/domain"
import { Cause, Context, Effect, Layer, Result, Schema } from "effect"
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

export type Section<A> = Result.Result<A, string>

export interface Snapshot {
  readonly subscriptions: Section<ReadonlyArray<Subscription.Subscription>>
  readonly plugins: Section<ReadonlyArray<Plugin.Plugin>>
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

/** Loads the active subscriptions and every plugin. A call the daemon answers with a defect fails only its own section. Fails with {@link DaemonNotRunning} when the socket cannot be opened. */
export const snapshot: Effect.Effect<Snapshot, DaemonNotRunning | DaemonUnreachable, DaemonClient> = Effect.gen(
  function*() {
    const client = yield* DaemonClient
    const subscriptions = yield* section(client.List({ all: false }))
    const plugins = yield* section(client.ListPlugins())
    return { subscriptions, plugins }
  }
)
