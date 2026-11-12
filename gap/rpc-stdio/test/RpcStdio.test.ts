import { BunServices } from "@effect/platform-bun"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Fiber, Stream } from "effect"
import { ChildProcess } from "effect/process"
import { RpcClient } from "effect/rpc"
import { RpcStdio } from "@exangelos/rpc-stdio"
import { EchoRpcs } from "./fixture/EchoRpcs.ts"

const startFixture = (options?: RpcStdio.Options, startupDelayMillis = 0) =>
  Effect.gen(function*() {
    const fixture = `${import.meta.dirname}/fixture/server.ts`
    const child = yield* ChildProcess.make(process.execPath, [fixture, String(startupDelayMillis)], {
      stderr: "inherit"
    })
    const protocol = yield* RpcStdio.makeProtocol(child, options)
    const client = yield* RpcClient.make(EchoRpcs).pipe(Effect.provideService(RpcClient.Protocol, protocol))
    return { child, client }
  })

const stdoutClosed = { _tag: "RpcClientError", reason: { _tag: "SocketCloseError" } }

describe("RpcStdio", () => {
  it.live("round-trips a unary call over the child's stdin and stdout", () =>
    Effect.gen(function*() {
      const { client } = yield* startFixture()
      expect(yield* client.Echo({ text: "hello" })).toBe("hello")
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)))

  it.live("streams every chunk the child emits", () =>
    Effect.gen(function*() {
      const { client } = yield* startFixture()
      expect(yield* Stream.runCollect(client.Count({ to: 3 }))).toEqual([1, 2, 3])
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)))

  it.live("stays connected across ping intervals", () =>
    Effect.gen(function*() {
      const { client } = yield* startFixture({ pingInterval: "50 millis", pingTimeout: "200 millis" })
      yield* client.Echo({ text: "up" })
      yield* Effect.sleep("600 millis")
      expect(yield* client.Echo({ text: "still here" })).toBe("still here")
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)))

  it.live("arms the ping only once a slow-starting child answers", () =>
    Effect.gen(function*() {
      const { client } = yield* startFixture({ pingInterval: "50 millis", pingTimeout: "200 millis" }, 600)
      expect(yield* client.Echo({ text: "late" })).toBe("late")
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)))

  it.live("fails an in-flight call and an open stream when the child dies", () =>
    Effect.gen(function*() {
      const { child, client } = yield* startFixture()
      const stalled = yield* Effect.forkChild(client.Stall())
      yield* Effect.yieldNow
      const ticks = yield* Stream.toPull(client.Tick())
      expect(yield* ticks).toEqual([1])

      yield* child.kill({ killSignal: "SIGKILL" })

      expect(yield* Effect.flip(ticks)).toMatchObject(stdoutClosed)
      expect(yield* Effect.flip(Fiber.join(stalled))).toMatchObject(stdoutClosed)
      expect(yield* Effect.flip(client.Echo({ text: "after" }))).toMatchObject(stdoutClosed)
      expect(yield* Effect.flip(child.exitCode)).toMatchObject({ _tag: "PlatformError" })
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)))
})
