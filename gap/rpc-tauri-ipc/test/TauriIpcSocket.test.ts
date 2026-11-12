import { describe, expect, it } from "@effect/vitest"
import { Cause, Deferred, Effect, Fiber, Layer, Queue, Schedule, Schema, Stream } from "effect"
import { NetAddress } from "effect/net"
import { Rpc, RpcClient, RpcClientError, RpcGroup, RpcSerialization, RpcServer } from "effect/rpc"
import { Socket, SocketServer } from "effect/socket"
import { TauriIpcSocket } from "@exangelos/rpc-tauri-ipc"

class TestRpcs extends RpcGroup.make(
  Rpc.make("Echo", { payload: { text: Schema.String }, success: Schema.String }),
  Rpc.make("Count", { payload: { to: Schema.Finite }, success: Schema.Finite, stream: true }),
  Rpc.make("Hold", { success: Schema.Finite, stream: true })
) {}

interface Pipe {
  readonly send: (message: unknown) => void
  readonly inbox: Queue.Queue<Uint8Array, Socket.SocketError>
}

const encoder = new TextEncoder()

// The far end of the relay: each relay_open hands a server-side Socket to a
// fake SocketServer, and every server write reaches the webview channel in
// pieces of `chunkSize` bytes, so lines and UTF-8 characters split.
const makeRelay = (options: { readonly chunkSize: number; readonly daemonUp: boolean }) =>
  Effect.gen(function*() {
    const context = yield* Effect.context<never>()
    const accepted = yield* Queue.unbounded<Socket.Socket>()
    const pipes = new Map<number, Pipe>()
    let nextId = 1
    let daemonUp = options.daemonUp

    const open = (events: unknown) => {
      if (!daemonUp) return Promise.reject("connect: no such file or directory")
      const channel = events as { readonly onMessage: (message: unknown) => void }
      const id = nextId++
      const inbox = Effect.runSyncWith(context)(Queue.unbounded<Uint8Array, Socket.SocketError>())
      const pipe: Pipe = { send: channel.onMessage, inbox }
      pipes.set(id, pipe)
      const toWebview = (chunk: Uint8Array | string) => {
        const bytes = typeof chunk === "string" ? encoder.encode(chunk) : chunk
        for (let at = 0; at < bytes.length; at += options.chunkSize) {
          pipe.send(bytes.slice(at, at + options.chunkSize).buffer)
        }
      }
      const serverSide = Socket.make({
        reader: Effect.succeed({ pull: Queue.takeAll(inbox), upgrade: Socket.SocketUpgradeError.unsupported }),
        writer: Effect.succeed({
          write: (chunk) => Effect.sync(() => Socket.isCloseEvent(chunk) ? undefined : toWebview(chunk)),
          writeAll: (chunks) => Effect.sync(() => chunks.forEach(toWebview))
        })
      })
      Queue.offerUnsafe(accepted, serverSide)
      return Promise.resolve(id)
    }

    const forget = (id: number) => {
      const pipe = pipes.get(id)
      pipes.delete(id)
      if (pipe !== undefined) {
        Queue.failCauseUnsafe(
          pipe.inbox,
          Cause.fail(new Socket.SocketError({ reason: new Socket.SocketCloseError({ code: 1000 }) }))
        )
      }
      return pipe
    }

    const ipc: TauriIpcSocket.TauriIpc = {
      makeChannel: (onMessage) => ({ onMessage }),
      invoke: (command, args, invokeOptions) => {
        switch (command) {
          case "relay_open":
            return open((args as { readonly events: unknown }).events)
          case "relay_write": {
            const id = Number(invokeOptions?.headers?.["exangelos-relay-connection"])
            const pipe = pipes.get(id)
            if (pipe === undefined) return Promise.reject(`unknown connection ${id}`)
            Queue.offerUnsafe(pipe.inbox, args as Uint8Array)
            return Promise.resolve(null)
          }
          case "relay_close":
            forget((args as { readonly connection: number }).connection)
            return Promise.resolve(null)
          default:
            return Promise.reject(`unknown command ${command}`)
        }
      }
    }

    const server = SocketServer.SocketServer.of({
      address: NetAddress.unixPathAddress("/fake/exangelos.sock"),
      run: (handler) =>
        Queue.take(accepted).pipe(
          Effect.flatMap((socket) => Effect.forkChild(handler(socket))),
          Effect.forever
        )
    })

    return {
      ipc,
      server,
      // The daemon goes away: every open connection reaches end of file.
      stopDaemon: () => {
        daemonUp = false
        for (const id of [...pipes.keys()]) forget(id)?.send({ type: "closed" })
      },
      startDaemon: () => {
        daemonUp = true
      }
    }
  })

const withClient = <A, E>(
  options: { readonly chunkSize: number; readonly daemonUp: boolean },
  body: (
    client: RpcClient.FromGroup<typeof TestRpcs, RpcClientError.RpcClientError>,
    relay: Effect.Success<ReturnType<typeof makeRelay>>,
    holding: Deferred.Deferred<void>
  ) => Effect.Effect<A, E>
) =>
  Effect.gen(function*() {
    const relay = yield* makeRelay(options)
    const holding = yield* Deferred.make<void>()
    const handlers = TestRpcs.toLayer({
      Echo: ({ text }) => Effect.succeed(text),
      Count: ({ to }) => Stream.range(1, to),
      Hold: () =>
        Stream.make(0).pipe(
          Stream.concat(Stream.fromEffect(Deferred.succeed(holding, undefined)).pipe(Stream.drain)),
          Stream.concat(Stream.never)
        )
    })
    const serverLayer = RpcServer.layer(TestRpcs).pipe(
      Layer.provide(handlers),
      Layer.provide(Layer.effect(RpcServer.Protocol)(RpcServer.makeProtocolSocketServer)),
      Layer.provide(Layer.succeed(SocketServer.SocketServer)(relay.server)),
      Layer.provide(RpcSerialization.layerNdjson)
    )
    const clientProtocol = RpcClient.layerProtocolSocket({ retryPolicy: Schedule.spaced("20 millis") }).pipe(
      Layer.provide(TauriIpcSocket.layer(relay.ipc)),
      Layer.provide(RpcSerialization.layerNdjson)
    )
    yield* Layer.build(serverLayer)
    return yield* RpcClient.make(TestRpcs).pipe(
      Effect.flatMap((client) => body(client, relay, holding)),
      Effect.provide(clientProtocol)
    )
  }).pipe(Effect.scoped)

describe("TauriIpcSocket", () => {
  it.live("carries a call and a stream through three-byte relay chunks", () =>
    withClient({ chunkSize: 3, daemonUp: true }, (client) =>
      Effect.gen(function*() {
        const text = "žluťoučký kůň 🐎 ".repeat(20)
        expect(yield* client.Echo({ text })).toBe(text)
        expect(Array.from(yield* Stream.runCollect(client.Count({ to: 50 })))).toEqual(
          Array.from({ length: 50 }, (_, i) => i + 1)
        )
      })))

  it.live("fails an in-flight call when the relay closes, then reconnects", () =>
    withClient({ chunkSize: 64, daemonUp: true }, (client, relay, holding) =>
      Effect.gen(function*() {
        const held = yield* Stream.runCollect(client.Hold()).pipe(Effect.flip, Effect.forkChild)
        yield* Deferred.await(holding)
        relay.stopDaemon()
        const error = yield* Fiber.join(held)
        expect(error._tag).toBe("RpcClientError")
        expect(error.reason).toMatchObject({ _tag: "SocketCloseError", code: 1000 })

        relay.startDaemon()
        const echoed = yield* client.Echo({ text: "back" }).pipe(
          Effect.retry({ schedule: Schedule.spaced("20 millis"), times: 50 })
        )
        expect(echoed).toBe("back")
      })))

  it.live("fails a call with an RpcClientError when the daemon is absent", () =>
    withClient({ chunkSize: 64, daemonUp: false }, (client) =>
      Effect.gen(function*() {
        const error = yield* client.Echo({ text: "anyone?" }).pipe(Effect.flip, Effect.timeout("2 seconds"))
        expect(error._tag).toBe("RpcClientError")
        expect(error.reason._tag).toBe("SocketOpenError")
      })))

  it.effect("fails the reader when the relay closes before relay_open resolves", () =>
    Effect.gen(function*() {
      const closed: Array<number> = []
      const socket = TauriIpcSocket.make({
        makeChannel: (onMessage) => onMessage,
        invoke: (command, args) => {
          if (command === "relay_open") {
            ;(args as { readonly events: (message: unknown) => void }).events({ type: "closed" })
            return Promise.resolve(7)
          }
          if (command === "relay_close") closed.push((args as { readonly connection: number }).connection)
          return Promise.resolve(null)
        }
      })
      const error = yield* socket.reader.pipe(Effect.scoped, Effect.flip)
      expect(error.reason).toMatchObject({ _tag: "SocketCloseError", code: 1000 })
      expect(closed).toEqual([7])
    }))
})
