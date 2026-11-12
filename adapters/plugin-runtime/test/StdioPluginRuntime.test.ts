import { BunServices } from "@effect/platform-bun"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Schema, Stream } from "effect"
import { ChildProcessSpawner } from "effect/process"
import type { ChildProcessHandle } from "effect/process/ChildProcessSpawner"
import { dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { PluginRuntime } from "@exangelos/application"
import { StdioPluginRuntime } from "@exangelos/plugin-runtime"
import { Template } from "@exangelos/plugin-template"

const templateDirectory = dirname(dirname(fileURLToPath(import.meta.resolve("@exangelos/plugin-template"))))

const launch = (directory: string, path: string) =>
  Schema.decodeSync(PluginRuntime.Launch)({
    name: "template",
    directory,
    entry: { _tag: "Bundle", path },
    dev: false
  })

const template = launch(templateDirectory, "src/main.ts")

const watchTicks = (ticks: number) =>
  Schema.decodeSync(PluginRuntime.WatchRequest)({ parameters: { ticks }, eventTypes: ["tick"] })

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

const runtime = StdioPluginRuntime.layer().pipe(Layer.provide(recordingSpawner))

const impatientRuntime = StdioPluginRuntime.layer({ startTimeout: "1 millis" }).pipe(Layer.provide(recordingSpawner))

const start = Effect.fnUntraced(function*(target: PluginRuntime.Launch) {
  const plugins = yield* PluginRuntime.PluginRuntime
  return yield* plugins.start(target)
})

describe("StdioPluginRuntime", () => {
  it.live("handshakes with the template plugin and returns its catalogue", () =>
    Effect.gen(function*() {
      const plugin = yield* start(template)
      expect(plugin.catalogue).toEqual(Template.plugin.catalogue)
    }).pipe(Effect.scoped, Effect.provide(runtime)))

  it.live("configures the plugin, then streams a watch to its end", () =>
    Effect.gen(function*() {
      const plugin = yield* start(template)
      expect(yield* plugin.configure({ token: "secret" })).toEqual({ _tag: "Accepted" })
      const items = yield* Stream.runCollect(plugin.watch(watchTicks(3)))
      expect(items.map((item) => item._tag)).toEqual(["Event", "Event", "Event", "End"])
      expect(items.at(-1)).toEqual({ _tag: "End", reason: "Emitted 3 ticks" })
    }).pipe(Effect.scoped, Effect.provide(runtime)))

  it.live("names the plugin when it rejects the credentials", () =>
    Effect.gen(function*() {
      const plugin = yield* start(template)
      const error = yield* Effect.flip(Stream.runDrain(plugin.watch(watchTicks(1))))
      expect(error).toMatchObject({ _tag: "CredentialsRejected", plugin: "template" })
    }).pipe(Effect.scoped, Effect.provide(runtime)))

  it.live("reports a killed plugin as crashed on its stream, its calls and its exit", () =>
    Effect.gen(function*() {
      const plugin = yield* start(template)
      yield* plugin.configure({ token: "secret", interval: "200" })
      const items = yield* Stream.toPull(plugin.watch(watchTicks(50)))
      expect(yield* items).toMatchObject([{ _tag: "Event" }])

      yield* spawned.at(-1)!.kill({ killSignal: "SIGKILL" })

      const crashed = { _tag: "PluginCrashed", plugin: "template" }
      expect(yield* Effect.flip(items)).toMatchObject(crashed)
      expect(yield* Effect.flip(plugin.describe({ ticks: 1 }))).toMatchObject(crashed)
      expect(yield* plugin.exited).toMatchObject(crashed)
    }).pipe(Effect.scoped, Effect.provide(runtime)))

  it.live("stops a plugin that does not answer the handshake in time", () =>
    Effect.gen(function*() {
      const error = yield* Effect.flip(start(template))
      expect(error).toMatchObject({ _tag: "PluginStartFailed", plugin: "template" })
      expect(yield* Effect.flip(spawned.at(-1)!.exitCode)).toMatchObject({ _tag: "PlatformError" })
    }).pipe(Effect.scoped, Effect.provide(impatientRuntime)))

  it.live("refuses a plugin that speaks another protocol version", () =>
    Effect.gen(function*() {
      const error = yield* Effect.flip(start(launch(`${import.meta.dirname}/fixture`, "incompatible.ts")))
      expect(error).toMatchObject({ _tag: "IncompatibleProtocol", plugin: "template", version: 2, supported: [1] })
    }).pipe(Effect.scoped, Effect.provide(runtime)))
})
