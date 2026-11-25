import { BunServices } from "@effect/platform-bun"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Exit, Fiber, Layer, Logger, Option, References, Schema, Scope, Stream } from "effect"
import { ChildProcessSpawner } from "effect/process"
import type { ChildProcessHandle } from "effect/process/ChildProcessSpawner"
import { dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { ConnectorRuntime } from "@exangelos/application"
import { ConnectorIcon, StdioConnectorRuntime } from "@exangelos/connector-runtime"
import * as Fs from "node:fs/promises"
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

const watchfulRuntime = StdioConnectorRuntime.layer({ pingInterval: "100 millis", pingTimeout: "300 millis" }).pipe(
  Layer.provide(recordingSpawner)
)

const hastyRuntime = StdioConnectorRuntime.layer({ stopTimeout: "200 millis" }).pipe(Layer.provide(recordingSpawner))

const start = Effect.fnUntraced(function*(target: ConnectorRuntime.Launch) {
  const connectors = yield* ConnectorRuntime.ConnectorRuntime
  return yield* connectors.start(target)
})

describe("StdioConnectorRuntime", { timeout: 30_000 }, () => {
  it.live("handshakes with the template connector and returns its catalogue", () =>
    Effect.gen(function*() {
      const connector = yield* start(template)
      expect(connector.catalogue).toEqual(Template.connector.catalogue)
    }).pipe(Effect.scoped, Effect.provide(runtime)))

  it.live("relays the icon the manifest names, which the SDK serves by default", () =>
    Effect.gen(function*() {
      const connector = yield* start(template)
      const file = yield* Effect.promise(() => Fs.readFile(`${templateDirectory}/icon.svg`))
      expect(yield* connector.icon).toEqual(Option.some({ mediaType: "image/svg+xml", data: file.toString("base64") }))
    }).pipe(Effect.scoped, Effect.provide(runtime)))

  const iconWarnings = (fixture: string) =>
    Effect.gen(function*() {
      const warnings: Array<unknown> = []
      const capture = Logger.make(({ logLevel, message }) => {
        if (logLevel === "Warn") warnings.push(message)
      })
      const connector = yield* start(launch(`${import.meta.dirname}/fixture`, fixture))
      const icon = yield* connector.icon.pipe(Effect.provide(Logger.layer([capture])))
      expect(icon).toEqual(Option.none())
      expect(yield* connector.configure({})).toEqual({ _tag: "Accepted" })
      return warnings
    })

  it.live("reads a connector built before the Icon method as having no icon, quietly, and keeps it running", () =>
    Effect.gen(function*() {
      expect(yield* iconWarnings("legacy.ts")).toEqual([])
    }).pipe(Effect.scoped, Effect.provide(runtime)))

  it.live("warns about an icon answer that does not decode and keeps the connector running", () =>
    Effect.gen(function*() {
      expect(yield* iconWarnings("malformed.ts")).toEqual([["Connector template has no icon: its icon answer is malformed"]])
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

  it.live("reports a running connector that stops answering while no call is in flight as exited", () =>
    Effect.gen(function*() {
      const connector = yield* start(template)
      const silent = spawned.at(-1)!
      yield* Effect.addFinalizer(() => Effect.ignore(silent.kill({ killSignal: "SIGKILL" })))
      // A stopped process keeps its pipes open but answers no ping, like a stalled one.
      process.kill(silent.pid, "SIGSTOP")
      const exited = yield* connector.exited.pipe(Effect.timeout("5 seconds"))
      expect(exited).toMatchObject({
        _tag: "ConnectorCrashed",
        reason: "Lost the connector's connection: it answered no ping for 300ms"
      })
      expect(yield* silent.isRunning).toBe(true)
    }).pipe(Effect.scoped, Effect.provide(watchfulRuntime)))

  it.live("replaces a connector that writes a frame that does not decode, which leaves its calls running", () =>
    Effect.gen(function*() {
      const connector = yield* start(launch(`${import.meta.dirname}/fixture`, "garbled.ts"))
      expect(yield* connector.configure({})).toEqual({ _tag: "Accepted" })
      const watch = yield* Stream.toPull(connector.watch(watchTicks(1)))
      expect(yield* watch).toMatchObject([{ _tag: "Cursor", cursor: "1" }])
      const crashed = { _tag: "ConnectorCrashed", connector: "template" }
      expect(yield* Effect.flip(watch)).toMatchObject(crashed)
      expect(yield* connector.exited.pipe(Effect.timeout("1 second"))).toMatchObject({
        ...crashed,
        reason: expect.stringContaining("RpcClientDefect")
      })
    }).pipe(Effect.scoped, Effect.provide(runtime)))

  it.live("logs each stderr line with the connector's name, through its exit", () =>
    Effect.gen(function*() {
      const lines: Array<{ readonly message: unknown; readonly connector: unknown }> = []
      const capture = Logger.make(({ fiber, message }) => {
        lines.push({ message, connector: fiber.getRef(References.CurrentLogAnnotations).connector })
      })
      yield* start(launch(`${import.meta.dirname}/fixture`, "noisy.ts")).pipe(
        Effect.flatMap((connector) => connector.exited),
        Effect.scoped,
        Effect.provide(Logger.layer([capture]))
      )
      expect(lines).toContainEqual({ message: ["connector stderr", "noisy starting"], connector: "template" })
      expect(lines).toContainEqual({ message: ["connector stderr", "noisy last words"], connector: "template" })
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

describe("checkIcon", () => {
  const svg = `<?xml version="1.0"?>\n<!-- mark --><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"/>`
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])
  const icon = (mediaType: "image/svg+xml" | "image/png", bytes: Buffer | string) => ({ mediaType, data: Buffer.from(bytes).toString("base64") })

  it("accepts an SVG and a PNG whose bytes match their media type", () => {
    expect(ConnectorIcon.checkIcon(icon("image/svg+xml", svg))._tag).toBe("Success")
    expect(ConnectorIcon.checkIcon(icon("image/png", png))._tag).toBe("Success")
  })

  it.each([
    ["an oversized icon", icon("image/svg+xml", Buffer.alloc(ConnectorIcon.maxIconBytes + 1)), "byte limit"],
    ["HTML served as SVG", icon("image/svg+xml", "<html><svg/></html>"), "not an SVG image"],
    ["invalid UTF-8 served as SVG", icon("image/svg+xml", Buffer.from([0x3c, 0x73, 0x76, 0x67, 0x20, 0xff, 0x3e])), "not an SVG image"],
    ["SVG served as PNG", icon("image/png", svg), "not a PNG image"],
    ["a GIF", { mediaType: "image/gif", data: "R0lGODlh" }, "not PNG or SVG"],
    ["data that is not base64", { mediaType: "image/png" as const, data: "%%%" }, "not base64"]
  ])("refuses %s", (_, served, reason) => {
    const checked = ConnectorIcon.checkIcon(served)
    expect(checked._tag === "Failure" ? checked.failure : "").toContain(reason)
  })
})
