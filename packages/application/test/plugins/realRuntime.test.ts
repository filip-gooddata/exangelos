import { BunServices } from "@effect/platform-bun"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Schedule } from "effect"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { configurePlugin, devLink, layerPlugins, PluginAccess } from "@exangelos/application"
import {
  layerAlertSink,
  layerPluginFiles,
  layerRepositories,
  layerSecretStore,
  layerServiceManager,
  layerSettingsStore,
  layerSubscriptionIntake,
  PluginFilesFake,
  SubscriptionIntakeFake
} from "@exangelos/application/testing"
// Imported by path: a workspace dependency on the runtime adapter would make a cycle, since it depends on this package.
import { StdioPluginRuntime } from "../../../../adapters/plugin-runtime/src/index.ts"
import { activeSubscription, installed, known, name, pluginOf, you } from "./harness.ts"

const templateDirectory = fileURLToPath(new URL("../../../../plugins/template", import.meta.url))

const runtime = StdioPluginRuntime.layer({
  commandFor: (launch) => ({ command: "bun", args: [resolve(launch.directory, launch.entry.path)], env: {} })
}).pipe(Layer.provide(BunServices.layer))

const layer = layerPlugins.pipe(Layer.provideMerge(Layer.mergeAll(
  layerRepositories,
  runtime,
  layerPluginFiles(known),
  layerSecretStore,
  layerSettingsStore(),
  layerAlertSink,
  layerSubscriptionIntake,
  layerServiceManager({ method: "launch-agent", installed: true, running: true })
)))

const template = name("template")

const until = <A, E, R>(effect: Effect.Effect<A, E, R>, done: (a: A) => boolean) =>
  effect.pipe(
    Effect.filterOrFail(done, () => "not yet"),
    Effect.retry(Schedule.spaced("20 millis")),
    Effect.timeout("10 seconds")
  )

describe("plugin supervision over the real runtime", () => {
  it.live("resumes a Watch of the template plugin after its stored cursor", () =>
    Effect.gen(function*() {
      yield* (yield* PluginFilesFake).put({
        ...installed("template", "sha256-template", templateDirectory),
        entry: { _tag: "Bundle", path: "src/main.ts" }
      })
      yield* devLink(you, templateDirectory)
      yield* until(pluginOf("template"), (plugin) => plugin.catalogue !== undefined)
      yield* configurePlugin(you, template, { token: "secret" })

      const intake = yield* SubscriptionIntakeFake
      const subscription = yield* activeSubscription("template", "sub_resume", "2", { ticks: 4 })
      yield* (yield* PluginAccess.PluginAccess).watch(subscription)
      const items = yield* until(intake.ingested(subscription), (all) => all.at(-1)?._tag === "End")

      expect(items).toHaveLength(3)
      expect(items).toMatchObject([
        { _tag: "Event", event: { type: "tick", payload: { index: 3 }, summary: "Tick 3 of 4" }, cursor: "3" },
        { _tag: "Event", event: { type: "tick", payload: { index: 4 }, summary: "Tick 4 of 4" }, cursor: "4" },
        { _tag: "End", reason: "Emitted 4 ticks; wake window 5000 ms" }
      ])
    }).pipe(Effect.provide(layer)), 30_000)
})
