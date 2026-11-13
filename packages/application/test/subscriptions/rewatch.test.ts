import { describe, expect, it } from "@effect/vitest"
import { Duration, Effect, Layer } from "effect"
import { enableConnector, importConnector, ConnectorAccess } from "@exangelos/application"
import { ConnectorFilesFake, ConnectorRuntimeFake } from "@exangelos/application/testing"
import { layerSubscriptionLocks } from "../../src/subscriptions/Locks.ts"
import { layerSubscriptionSignals } from "../../src/subscriptions/Signals.ts"
import { update } from "../../src/subscriptions/useCases/index.ts"
import { activeSubscription, catalogue, installed, name, settle, tick, withConnectorsOver, you } from "../connectors/harness.ts"

const acme = name("acme")

describe("update of an active subscription", () => {
  it.effect("reopens its Watch stream with the new parameters from the stored cursor", () =>
    withConnectorsOver(Layer.merge(layerSubscriptionLocks, layerSubscriptionSignals))(Effect.gen(function*() {
      const runtime = yield* ConnectorRuntimeFake
      yield* runtime.define(acme, { catalogue: catalogue() })
      const source = { _tag: "Directory", path: "/src/acme" } as const
      yield* (yield* ConnectorFilesFake).offer(source, installed("acme"))
      yield* enableConnector(you, acme, (yield* importConnector(you, source)).digest)
      yield* settle
      const id = yield* activeSubscription("acme", "sub_one", "c1")
      yield* (yield* ConnectorAccess.ConnectorAccess).watch(id)
      yield* settle

      yield* update(you, { id, parameters: { name: "sub_one", branch: "dev" } })
      yield* settle

      expect(yield* runtime.openStreams(acme)).toBe(1)
      expect((yield* runtime.watches(acme)).at(-1)).toEqual({
        parameters: { name: "sub_one", branch: "dev" },
        eventTypes: [tick],
        cursor: "c1",
        wakeWindow: Duration.seconds(5)
      })
    })))
})
