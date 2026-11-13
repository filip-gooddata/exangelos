import { BunServices } from "@effect/platform-bun"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Exit, Fiber, Layer, Schema, Scope, Stream } from "effect"
import { ChildProcessSpawner } from "effect/process"
import type { ChildProcessHandle } from "effect/process/ChildProcessSpawner"
import { dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { ConnectorRuntime } from "@exangelos/application"
import { StdioConnectorRuntime } from "@exangelos/connector-runtime"
import { Template } from "@exangelos/connector-template"

const templateDirectory = dirname(dirname(fileURLToPath(import.meta.resolve("@exangelos/connector-template"))))

const launch = (directory: string, path: string) =>
  Schema.decodeSync(ConnectorRuntime.Launch)({
    name: "template",
    directory,
    entry: { _tag: "Bundle", path },
    dev: false
  })

const template = launch(templateDirectory, "src/main.ts")

const watchTicks = (ticks: number) =>
  Schema.decodeSync(ConnectorRuntime.WatchRequest)({ parameters: { ticks }, eventTypes: ["tick"], wakeWindow: 1234 })

const spawned: Array<ChildProcessHandle> = []

const recordingSpawner = Layer.effect(
  ChildProcessSpawner.ChildProcessSpawner,
  Effect.gen(function*() {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    return ChildProcessSpawner.ChildProcessSpawner.of({
      ...spawner,
      spawn: (command) => Effect.tap(spawner.spawn(command), (handle) => Effect.sync(() => spawned.push(handle)))
    })
  })
).pipe(Layer.provide(BunServices.layer))

const runtime = StdioConnectorRuntime.layer().pipe(Layer.provide(recordingSpawner))

const impatientRuntime = StdioConnectorRuntime.layer({ startTimeout: "1 millis" }).pipe(Layer.provide(recordingSpawner))

const hastyRuntime = StdioConnectorRuntime.layer({ stopTimeout: "200 millis" }).pipe(Layer.provide(recordingSpawner))

const start = Effect.fnUntraced(function*(target: ConnectorRuntime.Launch) {
  const connectors = yield* ConnectorRuntime.ConnectorRuntime
  return yield* connectors.start(target)
})

describe("StdioConnectorRuntime", () => {
  it.live("handshakes with the template connector and returns its catalogue", () =>
    Effect.gen(function*() {
      const connector = yield* start(template)
      expect(connector.catalogue).toEqual(Template.connector.catalogue)
    }).pipe(Effect.scoped, Effect.provide(runtime)))

  it.live("configures the connector, then streams a watch to its end", () =>
    Effect.gen(function*() {
      const connector = yield* start(template)
      expect(yield* connector.configure({ token: "secret" })).toEqual({ _tag: "Accepted" })
      const items = yield* Stream.runCollect(connector.watch(watchTicks(3)))
      expect(items.map((item) => item._tag)).toEqual(["Event", "Event", "Event", "End"])
      expect(items.at(-1)).toEqual({ _tag: "End", reason: "Emitted 3 ticks; wake window 1234 ms" })
    }).pipe(Effect.scoped, Effect.provide(runtime)))

  it.live("names the connector when it rejects the credentials", () =>
    Effect.gen(function*() {
      const connector = yield* start(template)
      const error = yield* Effect.flip(Stream.runDrain(connector.watch(watchTicks(1))))
      expect(error).toMatchObject({ _tag: "CredentialsRejected", connector: "template" })
    }).pipe(Effect.scoped, Effect.provide(runtime)))

  it.live("reports a killed connector as crashed on its stream, its calls and its exit", () =>
    Effect.gen(function*() {
      const connector = yield* start(template)
      yield* connector.configure({ token: "secret", interval: "200" })
      const items = yield* Stream.toPull(connector.watch(watchTicks(50)))
      expect(yield* items).toMatchObject([{ _tag: "Event" }])

      yield* spawned.at(-1)!.kill({ killSignal: "SIGKILL" })

      const crashed = { _tag: "ConnectorCrashed", connector: "template" }
      expect(yield* Effect.flip(items)).toMatchObject(crashed)
      expect(yield* Effect.flip(connector.describe({ ticks: 1 }))).toMatchObject(crashed)
      expect(yield* connector.exited).toMatchObject(crashed)
    }).pipe(Effect.scoped, Effect.provide(runtime)))

  it.live("stops a connector that does not answer the handshake in time", () =>
    Effect.gen(function*() {
      const error = yield* Effect.flip(start(template))
      expect(error).toMatchObject({ _tag: "ConnectorStartFailed", connector: "template" })
      expect(yield* Effect.flip(spawned.at(-1)!.exitCode)).toMatchObject({ _tag: "PlatformError" })
    }).pipe(Effect.scoped, Effect.provide(impatientRuntime)))

  it.live("kills a connector that ignores SIGTERM once the stop timeout passes", () =>
    Effect.gen(function*() {
      const scope = yield* Scope.make()
      yield* start(launch(`${import.meta.dirname}/fixture`, "stubborn.ts")).pipe(Scope.provide(scope))
      const stubborn = spawned.at(-1)!
      yield* Effect.addFinalizer(() => Effect.ignore(stubborn.kill({ killSignal: "SIGKILL" })))
      const closing = yield* Effect.forkDetach(Scope.close(scope, Exit.void))
      yield* Fiber.join(closing).pipe(Effect.timeout("3 seconds"))
      expect(yield* stubborn.isRunning).toBe(false)
    }).pipe(Effect.scoped, Effect.provide(hastyRuntime)))

  it.live("refuses a connector that speaks another protocol version", () =>
    Effect.gen(function*() {
      const error = yield* Effect.flip(start(launch(`${import.meta.dirname}/fixture`, "incompatible.ts")))
      expect(error).toMatchObject({ _tag: "IncompatibleProtocol", connector: "template", version: 2, supported: [1] })
    }).pipe(Effect.scoped, Effect.provide(runtime)))
})
