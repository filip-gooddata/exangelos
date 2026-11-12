import type { NonEmptyReadonlyArray } from "effect/Array"
import { Cause, Deferred, Duration, Effect, Queue, Schedule, Scope, Stream } from "effect"
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
 * The protocol sends a first ping and is created once the child writes its first
 * output, so it waits for the child to start without a deadline; bound it with a
 * timeout if needed. From
 * then on the client pings every `pingInterval` (default 5 seconds), and if no
 * frame arrives within `pingTimeout` (default `pingInterval`), calls fail with a
 * `SocketReadError` reason.
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

const ping = encoder.encode(`${JSON.stringify({ _tag: "Ping" })}\n`)

const toBytes = (chunk: Uint8Array | string) => typeof chunk === "string" ? encoder.encode(chunk) : chunk

const closed = (closeReason: string) =>
  new Socket.SocketError({ reason: new Socket.SocketCloseError({ code: 1000, closeReason }) })

const makeSocket = (child: ChildProcessSpawner.ChildProcessHandle): Effect.Effect<Socket.Socket, never, Scope.Scope> =>
  Effect.gen(function*() {
    const broken = yield* Deferred.make<never, Socket.SocketError>()
    const outgoing = yield* Queue.unbounded<Uint8Array, Cause.Done>()
    yield* Stream.fromQueue(outgoing).pipe(
      Stream.run(child.stdin),
      Effect.catch((cause) =>
        Deferred.fail(broken, new Socket.SocketError({ reason: new Socket.SocketWriteError({ cause }) }))
      ),
      Effect.forkScoped
    )

    const pull = Effect.mapError(yield* Stream.toPull(child.stdout), (error) =>
      Cause.isDone(error)
        ? closed("child process closed stdout")
        : new Socket.SocketError({ reason: new Socket.SocketReadError({ cause: error }) }))
    yield* Queue.offer(outgoing, ping)
    let first: Effect.Effect<NonEmptyReadonlyArray<Uint8Array>, Socket.SocketError> | undefined = yield* Effect.exit(
      Effect.raceFirst(pull, Deferred.await(broken))
    )

    const reader = Effect.gen(function*() {
      yield* Effect.addFinalizer(() => Deferred.fail(broken, closed("reader closed")))
      return {
        pull: Effect.suspend(() => {
          const next = first ?? pull
          first = undefined
          return next
        }).pipe(Effect.raceFirst(Deferred.await(broken))),
        upgrade: Socket.SocketUpgradeError.unsupported
      }
    })

    const writer: Socket.Writer = {
      write: (chunk) =>
        Socket.isCloseEvent(chunk) ? Effect.asVoid(Queue.end(outgoing)) : Effect.asVoid(Queue.offer(outgoing, toBytes(chunk))),
      writeAll: (chunks) => Effect.asVoid(Queue.offerAll(outgoing, chunks.map(toBytes)))
    }

    return Socket.make({ reader, writer: Effect.as(Effect.addFinalizer(() => Queue.end(outgoing)), writer) })
  })
