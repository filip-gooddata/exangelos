import { describe, expect, it } from "@effect/vitest"
import { DateTime, Effect, Layer } from "effect"
import { TestClock } from "effect/testing"
import { enablePlugin, importPlugin, layerPlugins, removePlugin } from "@exangelos/application"
import {
  layerAlertSink,
  layerPluginFiles,
  layerPluginRuntime,
  layerRepositories,
  layerSecretStore,
  layerServiceManager,
  layerSettingsStore,
  layerSubscriptionIntake,
  PluginFilesFake,
  PluginRuntimeFake,
  SubscriptionIntakeFake
} from "@exangelos/application/testing"
import { activeSubscription, catalogue, installed, known, name, settle, you } from "./harness.ts"

/** The ports outlive each daemon run below, as the stores on disk would. */
const ports = Layer.mergeAll(
  layerRepositories,
  layerPluginRuntime,
  layerPluginFiles(known),
  layerSecretStore,
  layerSettingsStore(),
  layerAlertSink,
  layerSubscriptionIntake,
  layerServiceManager({ method: "launch-agent", installed: true, running: true })
)

/** One daemon run: the plugin half started over the shared ports, stopped when `effect` ends. */
const daemonRun = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.scoped(Effect.flatMap(Layer.build(layerPlugins), (context) => Effect.provide(effect, context)))

describe("a removed plugin", () => {
  it.effect("is reported on removal and again an hour later, across a daemon restart", () =>
    Effect.provide(
      Effect.gen(function*() {
        const intake = yield* SubscriptionIntakeFake
        const removedAt = yield* daemonRun(Effect.gen(function*() {
          yield* (yield* PluginRuntimeFake).define(name("acme"), { catalogue: catalogue() })
          const source = { _tag: "Directory", path: "/src/acme" } as const
          yield* (yield* PluginFilesFake).offer(source, installed("acme"))
          const imported = yield* importPlugin(you, source)
          yield* enablePlugin(you, name("acme"), imported.digest)
          yield* activeSubscription("acme", "sub_one")
          yield* settle
          yield* TestClock.adjust("5 minutes")
          const at = yield* DateTime.now
          yield* removePlugin(you, name("acme"))
          yield* settle
          return at
        }))
        expect(yield* intake.pluginRemovals).toEqual([{ plugin: "acme", since: removedAt, problem: "removed by you" }])

        yield* daemonRun(Effect.gen(function*() {
          yield* settle
          yield* TestClock.adjust("59 minutes")
          yield* settle
          expect(yield* intake.pluginRemovals).toHaveLength(1)
          yield* TestClock.adjust("1 minute")
          yield* settle
        }))

        expect(yield* intake.pluginRemovals).toEqual([
          { plugin: "acme", since: removedAt, problem: "removed by you" },
          { plugin: "acme", since: removedAt, problem: "removed by you" }
        ])
      }),
      ports
    ))
})
