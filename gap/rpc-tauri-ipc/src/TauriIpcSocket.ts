import { Effect, Latch, Layer, Semaphore } from "effect"
import type { NonEmptyReadonlyArray } from "effect/Array"
import { Socket } from "effect/socket"

/**
 * The two Tauri functions the socket needs. In the app, `invoke` is
 * `@tauri-apps/api/core`'s `invoke` and `makeChannel` is `(f) => new Channel(f)`.
 */
export interface TauriIpc {
  readonly invoke: (
    command: string,
    args?: unknown,
    options?: { readonly headers?: Record<string, string> }
  ) => Promise<unknown>
  readonly makeChannel: (onMessage: (message: unknown) => void) => unknown
}

const connectionHeader = "exangelos-relay-connection"

const encoder = new TextEncoder()

interface Connection {
  readonly id: number
  readonly close: (event: Socket.CloseEvent) => void
}

const closeError = (code: number, closeReason?: string) =>
  new Socket.SocketError({ reason: new Socket.SocketCloseError({ code, closeReason }) })

const readError = (cause: unknown) => new Socket.SocketError({ reason: new Socket.SocketReadError({ cause }) })

const toBytes = (message: unknown): Uint8Array | undefined => {
  if (message instanceof ArrayBuffer) return new Uint8Array(message)
  if (ArrayBuffer.isView(message)) return new Uint8Array(message.buffer, message.byteOffset, message.byteLength)
  return undefined
}

/**
 * A `Socket` over the tray host's byte relay.
 *
 * Acquiring `reader` opens a relay connection (`relay_open`) with a fresh
 * channel, and its scope closes it (`relay_close`). The relay's
 * `{type:"closed"}` fails `pull` with a `SocketCloseError` of code 1000 and
 * `{type:"error"}` with a `SocketReadError`; an open rejection fails the
 * acquisition with a `SocketOpenError`. Writes go out one at a time, in order,
 * to the current connection, and suspend while there is none.
 */
export const make = (ipc: TauriIpc): Socket.Socket => {
  let current: Connection | undefined
  const connected = Latch.makeUnsafe(false)
  const writeLock = Semaphore.makeUnsafe(1)

  const closeRelay = (id: number) =>
    Effect.tryPromise(() => ipc.invoke("relay_close", { connection: id })).pipe(Effect.ignore)

  const reader: Socket.Socket["reader"] = Effect.gen(function*() {
    let buffer: Array<Uint8Array> = []
    let failure: Socket.SocketError | undefined
    let waiter: ((effect: Effect.Effect<NonEmptyReadonlyArray<Uint8Array>, Socket.SocketError>) => void) | undefined
    let connection: Connection | undefined

    const takeBuffer = () => {
      const frames = buffer as unknown as NonEmptyReadonlyArray<Uint8Array>
      buffer = []
      return frames
    }
    const fail = (error: Socket.SocketError) => {
      if (failure !== undefined) return
      failure = error
      if (connection !== undefined && current === connection) {
        current = undefined
        connected.closeUnsafe()
      }
      if (waiter !== undefined) {
        const resume = waiter
        waiter = undefined
        resume(buffer.length > 0 ? Effect.succeed(takeBuffer()) : Effect.fail(error))
      }
    }
    const onMessage = (message: unknown) => {
      if (failure !== undefined) return
      const bytes = toBytes(message)
      if (bytes !== undefined) {
        if (bytes.byteLength === 0) return
        buffer.push(bytes)
        if (waiter !== undefined) {
          const resume = waiter
          waiter = undefined
          resume(Effect.succeed(takeBuffer()))
        }
        return
      }
      const event = message as { readonly type?: unknown; readonly message?: unknown } | null
      if (event?.type === "closed") return fail(closeError(1000))
      if (event?.type === "error") return fail(readError(new Error(String(event.message))))
      fail(readError(new Error("Unexpected relay message")))
    }

    const id = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () => ipc.invoke("relay_open", { events: ipc.makeChannel(onMessage) }) as Promise<number>,
        catch: (cause) => new Socket.SocketError({ reason: new Socket.SocketOpenError({ kind: "Unknown", cause }) })
      }),
      (id) =>
        Effect.suspend(() => {
          fail(closeError(1000))
          return closeRelay(id)
        })
    )

    connection = {
      id,
      close: (event) => fail(closeError(event.code, event.reason))
    }
    if (failure === undefined) {
      current = connection
      connected.openUnsafe()
    }

    return {
      pull: Effect.callback<NonEmptyReadonlyArray<Uint8Array>, Socket.SocketError>((resume) => {
        if (buffer.length > 0) return resume(Effect.succeed(takeBuffer()))
        if (failure !== undefined) return resume(Effect.fail(failure))
        waiter = resume
        return Effect.sync(() => {
          if (waiter === resume) waiter = undefined
        })
      }),
      upgrade: Socket.SocketUpgradeError.unsupported
    }
  })

  const send = (bytes: Uint8Array): Effect.Effect<void, Socket.SocketError> =>
    Effect.suspend(() => {
      const target = current
      if (target === undefined) return connected.whenOpen(send(bytes))
      return Effect.tryPromise({
        try: () => ipc.invoke("relay_write", bytes, { headers: { [connectionHeader]: String(target.id) } }),
        catch: (cause) => new Socket.SocketError({ reason: new Socket.SocketWriteError({ cause }) })
      }).pipe(Effect.asVoid, Effect.uninterruptible)
    })

  const closeCurrent = (event: Socket.CloseEvent): Effect.Effect<void> =>
    Effect.suspend(() => {
      const target = current
      if (target === undefined) return Effect.void
      target.close(event)
      return closeRelay(target.id)
    })

  const write = (chunk: Uint8Array | string | Socket.CloseEvent) =>
    writeLock.withPermit(
      Socket.isCloseEvent(chunk)
        ? closeCurrent(chunk)
        : send(typeof chunk === "string" ? encoder.encode(chunk) : chunk)
    )

  const writeAll = (chunks: NonEmptyReadonlyArray<Uint8Array | string>) => {
    const parts = chunks.map((chunk) => typeof chunk === "string" ? encoder.encode(chunk) : chunk)
    const bytes = new Uint8Array(parts.reduce((size, part) => size + part.byteLength, 0))
    let offset = 0
    for (const part of parts) {
      bytes.set(part, offset)
      offset += part.byteLength
    }
    return writeLock.withPermit(send(bytes))
  }

  return Socket.make({ reader, writer: Effect.succeed({ write, writeAll }) })
}

/**
 * Provides `Socket.Socket` over the relay, for `RpcClient.layerProtocolSocket`.
 */
export const layer = (ipc: TauriIpc): Layer.Layer<Socket.Socket> => Layer.succeed(Socket.Socket)(make(ipc))
