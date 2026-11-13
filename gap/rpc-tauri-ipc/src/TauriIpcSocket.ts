import { Effect, Latch, Layer, Scope } from "effect"
import type { NonEmptyReadonlyArray } from "effect/Array"
import { constVoid } from "effect/Function"
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
  readonly write: (bytes: Uint8Array) => Promise<unknown>
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
 * acquisition with a `SocketOpenError`. Writes, including a `CloseEvent`,
 * suspend while there is no connection. Each connection sends its writes to
 * the relay one at a time in call order; a caller that stops waiting does not
 * reorder or cancel bytes already handed over.
 */
export const make = (ipc: TauriIpc): Socket.Socket => {
  let current: Connection | undefined
  const connected = Latch.makeUnsafe(false)

  const closeRelayUnsafe = (id: number) => ipc.invoke("relay_close", { connection: id }).then(constVoid, constVoid)
  const closeRelay = (id: number) => Effect.promise(() => closeRelayUnsafe(id))

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

    let opened: number | undefined
    yield* Scope.addFinalizer(
      yield* Effect.scope,
      Effect.suspend(() => {
        fail(closeError(1000))
        return opened === undefined ? Effect.void : closeRelay(opened)
      })
    )

    const id = yield* Effect.callback<number, Socket.SocketError>((resume) => {
      let abandoned = false
      ipc.invoke("relay_open", { events: ipc.makeChannel(onMessage) }).then(
        (value) => {
          const id = value as number
          if (abandoned) return void closeRelayUnsafe(id)
          opened = id
          resume(Effect.succeed(id))
        },
        (cause) => {
          if (abandoned) return
          resume(Effect.fail(new Socket.SocketError({ reason: new Socket.SocketOpenError({ kind: "Unknown", cause }) })))
        }
      )
      return Effect.sync(() => {
        abandoned = true
      })
    })

    // The relay may report end of file before relay_open resolves.
    if (failure !== undefined) return yield* failure

    let tail: Promise<unknown> = Promise.resolve()
    const headers = { [connectionHeader]: String(id) }
    connection = {
      id,
      write: (bytes) => {
        const sent = tail.then(() => ipc.invoke("relay_write", bytes, { headers }))
        tail = sent.then(constVoid, constVoid)
        return sent
      },
      close: (event) => fail(closeError(event.code, event.reason))
    }
    current = connection
    connected.openUnsafe()

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
        try: () => target.write(bytes),
        catch: (cause) => new Socket.SocketError({ reason: new Socket.SocketWriteError({ cause }) })
      }).pipe(Effect.asVoid)
    })

  const closeCurrent = (event: Socket.CloseEvent): Effect.Effect<void> =>
    Effect.suspend(() => {
      const target = current
      if (target === undefined) return connected.whenOpen(closeCurrent(event))
      target.close(event)
      return closeRelay(target.id)
    })

  const write = (chunk: Uint8Array | string | Socket.CloseEvent) =>
    Socket.isCloseEvent(chunk) ? closeCurrent(chunk) : send(typeof chunk === "string" ? encoder.encode(chunk) : chunk)

  const writeAll = (chunks: NonEmptyReadonlyArray<Uint8Array | string>) => {
    const parts = chunks.map((chunk) => typeof chunk === "string" ? encoder.encode(chunk) : chunk)
    const bytes = new Uint8Array(parts.reduce((size, part) => size + part.byteLength, 0))
    let offset = 0
    for (const part of parts) {
      bytes.set(part, offset)
      offset += part.byteLength
    }
    return send(bytes)
  }

  return Socket.make({ reader, writer: Effect.succeed({ write, writeAll }) })
}

/**
 * Provides `Socket.Socket` over the relay, for `RpcClient.layerProtocolSocket`.
 */
export const layer = (ipc: TauriIpc): Layer.Layer<Socket.Socket> => Layer.succeed(Socket.Socket)(make(ipc))
