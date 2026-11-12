import { Context, Effect, Layer } from "effect"
import { DaemonClient } from "@exangelos/daemon-client"

type Client = DaemonClient.DaemonClient["Service"]

export type Lazy = {
  readonly [K in keyof Client]: Client[K] extends (...args: infer P) => Effect.Effect<infer A, infer E, infer R>
    ? (...args: P) => Effect.Effect<A, E | DaemonClient.DaemonNotRunning, R>
    : never
}

/** The daemon client commands call. Connecting happens on the first call; when it fails, every call fails with `DaemonNotRunning`. */
export class Connection extends Context.Service<Connection, Lazy>()("@exangelos/cli/Connection") {}

/** Provides {@link Connection} over `client`, built once on the first daemon call a command makes. */
export const layer = <R>(
  client: Layer.Layer<DaemonClient.DaemonClient, DaemonClient.DaemonNotRunning, R>
): Layer.Layer<Connection, never, R> =>
  Layer.effect(
    Connection,
    Effect.gen(function*() {
      const scope = yield* Effect.scope
      const context = yield* Effect.context<R>()
      const connect = yield* Effect.cached(
        Layer.buildWithScope(client, scope).pipe(
          Effect.map((built) => Context.get(built, DaemonClient.DaemonClient)),
          Effect.provide(context)
        )
      )
      const call = (rpc: string) => (...args: ReadonlyArray<unknown>) =>
        Effect.flatMap(connect, (connected) =>
          (connected as unknown as Record<string, (...args: ReadonlyArray<unknown>) => Effect.Effect<unknown, unknown>>)[
            rpc
          ](...args))
      return new Proxy({}, { get: (_, rpc) => call(String(rpc)) }) as Lazy
    })
  )
