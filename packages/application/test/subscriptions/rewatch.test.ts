import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { enablePlugin, importPlugin, PluginAccess } from "@exangelos/application"
import { PluginFilesFake, PluginRuntimeFake } from "@exangelos/application/testing"
import { layerSubscriptionLocks } from "../../src/subscriptions/Locks.ts"
import { layerSubscriptionSignals } from "../../src/subscriptions/Signals.ts"
import { update } from "../../src/subscriptions/useCases/index.ts"
import { activeSubscription, catalogue, installed, name, settle, tick, withPluginsOver, you } from "../plugins/harness.ts"

const acme = name("acme")

describe("update of an active subscription", () => {
  it.effect("reopens its Watch stream with the new parameters from the stored cursor", () =>
    withPluginsOver(Layer.merge(layerSubscriptionLocks, layerSubscriptionSignals))(Effect.gen(function*() {
      const runtime = yield* PluginRuntimeFake
      yield* runtime.define(acme, { catalogue: catalogue() })
      const source = { _tag: "Directory", path: "/src/acme" } as const
      yield* (yield* PluginFilesFake).offer(source, installed("acme"))
      yield* enablePlugin(you, acme, (yield* importPlugin(you, source)).digest)
      yield* settle
      const id = yield* activeSubscription("acme", "sub_one", "c1")
      yield* (yield* PluginAccess.PluginAccess).watch(id)
      yield* settle

      yield* update(you, { id, parameters: { name: "sub_one", branch: "dev" } })
      yield* settle

      expect(yield* runtime.openStreams(acme)).toBe(1)
      expect((yield* runtime.watches(acme)).at(-1)).toEqual({
        parameters: { name: "sub_one", branch: "dev" },
        eventTypes: [tick],
        cursor: "c1"
      })
    })))
})
