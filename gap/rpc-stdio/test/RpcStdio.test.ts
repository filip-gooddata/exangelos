import { BunServices } from "@effect/platform-bun"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Fiber, FileSystem, Queue, Sink, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { TestClock } from "effect/testing"
import { RpcClient } from "effect/rpc"
import { RpcStdio } from "@exangelos/rpc-stdio"
import { EchoRpcs } from "./fixture/EchoRpcs.ts"

const decoder = new TextDecoder()

const count = (chunk: Uint8Array, tag: string) => decoder.decode(chunk).split(`"_tag":"${tag}"`).length - 1

const signal = (queue: Queue.Queue<void>, times: number) => Queue.offerAll(queue, Array.from({ length: times }, () => undefined))

const spawnFixture = (gate?: string) =>
  Effect.gen(function*() {
    const fixture = `${import.meta.dirname}/fixture/server.ts`
    const spawned = yield* ChildProcess.make(process.execPath, gate === undefined ? [fixture] : [fixture, gate], {
      stderr: "inherit"
    })
    const pings = yield* Queue.unbounded<void>()
    const pongs = yield* Queue.unbounded<void>()
    const child = ChildProcessSpawner.makeHandle({
      ...spawned,
      stdin: Sink.mapInputEffect(spawned.stdin, (chunk: Uint8Array) => Effect.as(signal(pings, count(chunk, "Ping")), chunk)),
      stdout: Stream.tap(spawned.stdout, (chunk) => signal(pongs, count(chunk, "Pong")))
    })
    return { child, pings, pongs }
  })

const connect = (child: ChildProcessSpawner.ChildProcessHandle, options?: RpcStdio.Options) =>
  Effect.gen(function*() {
    const protocol = yield* RpcStdio.makeProtocol(child, options)
    return yield* RpcClient.make(EchoRpcs).pipe(Effect.provideService(RpcClient.Protocol, protocol))
  })

const startFixture = (options?: RpcStdio.Options) =>
  Effect.gen(function*() {
    const fixture = yield* spawnFixture()
    return { ...fixture, client: yield* connect(fixture.child, options) }
  })

const stdoutClosed = { _tag: "RpcClientError", reason: { _tag: "SocketCloseError" } }

describe("RpcStdio", { timeout: 30_000 }, () => {
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

  it.effect("stays connected across ping intervals", () =>
    Effect.gen(function*() {
      const { client, pongs } = yield* startFixture({ pingInterval: "50 millis", pingTimeout: "200 millis" })
      yield* client.Echo({ text: "up" })
      yield* Queue.take(pongs)
      const stalled = yield* Effect.forkChild(client.Stall())
      for (let interval = 0; interval < 12; interval++) {
        yield* TestClock.adjust("50 millis")
        yield* Effect.raceFirst(Queue.take(pongs), Fiber.join(stalled))
      }
      expect(yield* client.Echo({ text: "still here" })).toBe("still here")
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)))

  it.effect("arms the ping only once a slow-starting child answers", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const gate = `${yield* fs.makeTempDirectoryScoped()}/started`
      const { child, pings } = yield* spawnFixture(gate)
      const connecting = yield* Effect.forkChild(connect(child, { pingInterval: "50 millis", pingTimeout: "200 millis" }))
      yield* Queue.take(pings)
      yield* TestClock.adjust("1 minute")
      yield* fs.writeFileString(gate, "")
      const client = yield* Fiber.join(connecting)
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
