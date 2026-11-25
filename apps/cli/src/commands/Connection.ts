import { Cause, Context, Effect, Layer } from "effect"
import { RpcClientError } from "effect/rpc"
import { DaemonClient } from "@exangelos/daemon-client"

type Client = DaemonClient.DaemonClient["Service"]

export type Lazy = {
  readonly [K in keyof Client]: Client[K] extends (...args: infer P) => Effect.Effect<infer A, infer E, infer R>
    ? (...args: P) => Effect.Effect<A, E | DaemonClient.DaemonNotRunning, R>
    : never
}

export class Connection extends Context.Service<Connection, Lazy>()("@exangelos/cli/Connection") {}

/**
 * A daemon that shuts down mid-call answers with an interruption. Left as is, the CLI would exit 130 with no output,
 * as if a signal had stopped it; an interruption of this process itself is not catchable and still exits 130.
 */
const daemonStopped = new RpcClientError.RpcClientError({
  reason: new RpcClientError.RpcClientDefect({ message: "the daemon stopped before it answered", cause: undefined })
})

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
          ](...args)).pipe(Effect.catchCauseIf(Cause.hasInterruptsOnly, () => Effect.fail(daemonStopped)))
      return new Proxy({}, { get: (_, rpc) => call(String(rpc)) }) as Lazy
    })
  )
