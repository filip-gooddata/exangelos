import { Cause, Duration, Effect, Queue, Schedule, Scope, Stream } from "effect"
import type { ChildProcessSpawner } from "effect/process"
import { RpcClient, RpcSerialization } from "effect/rpc"
import { Socket } from "effect/socket"

export interface Options {
  readonly pingInterval?: Duration.Input | undefined
  readonly pingTimeout?: Duration.Input | undefined
}

/**
 * An Effect RPC client protocol speaking NDJSON over a spawned child's stdin and stdout.
 *
 * Spawn the child with `stdout: "pipe"` and keep stderr off the pipe or drain it.
 * When the child's stdout closes, in-flight calls and open streams fail with an
 * `RpcClientError` whose reason is a `SocketCloseError`, and later calls fail with
 * the same error. The protocol never respawns the child; observe its exit through
 * the handle's `exitCode`.
 *
 * The client pings every `pingInterval` (default 5 seconds). If no frame arrives
 * within `pingTimeout` (default `pingInterval`), counted from creation and so
 * including the child's startup, calls fail with a `SocketReadError` reason.
 */
export const makeProtocol = (
  child: ChildProcessSpawner.ChildProcessHandle,
  options?: Options
): Effect.Effect<RpcClient.Protocol["Service"], never, Scope.Scope> =>
  Effect.gen(function*() {
    const socket = yield* makeSocket(child)
    return yield* RpcClient.makeProtocolSocket({ ...options, retryPolicy: Schedule.recurs(0) }).pipe(
      Effect.provideService(Socket.Socket, socket),
      Effect.provideService(RpcSerialization.RpcSerialization, RpcSerialization.ndjson)
    )
  })

const encoder = new TextEncoder()

const toBytes = (chunk: Uint8Array | string) => typeof chunk === "string" ? encoder.encode(chunk) : chunk

const stdoutClosed = new Socket.SocketError({
  reason: new Socket.SocketCloseError({ code: 1000, closeReason: "child process closed stdout" })
})

const makeSocket = (child: ChildProcessSpawner.ChildProcessHandle): Effect.Effect<Socket.Socket, never, Scope.Scope> =>
  Effect.gen(function*() {
    const outgoing = yield* Queue.unbounded<Uint8Array, Cause.Done>()
    yield* Stream.fromQueue(outgoing).pipe(Stream.run(child.stdin), Effect.ignore, Effect.forkScoped)

    const reader = Effect.gen(function*() {
      const pull = yield* Stream.toPull(child.stdout)
      return {
        pull: Effect.mapError(pull, (error) =>
          Cause.isDone(error)
            ? stdoutClosed
            : new Socket.SocketError({ reason: new Socket.SocketReadError({ cause: error }) })),
        upgrade: Socket.SocketUpgradeError.unsupported
      }
    })

    const writer: Socket.Writer = {
      write: (chunk) =>
        Socket.isCloseEvent(chunk) ? Effect.asVoid(Queue.end(outgoing)) : Effect.asVoid(Queue.offer(outgoing, toBytes(chunk))),
      writeAll: (chunks) => Effect.asVoid(Queue.offerAll(outgoing, chunks.map(toBytes)))
    }

    return Socket.make({ reader, writer: Effect.succeed(writer) })
  })
