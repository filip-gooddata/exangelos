import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { listPluginAlerts, OfficialPluginSource, PluginRepository } from "@exangelos/application"
import { layerRepositories } from "@exangelos/application/testing"
import { plugin } from "../fixtures.ts"

const official = Layer.succeed(OfficialPluginSource.OfficialPluginSource)({
  known: [
    { name: plugin("disabled").name, version: "1.0.0", digest: "sha256-test" },
    { name: plugin("tampered").name, version: "1.0.0", digest: "sha256-release" }
  ],
  fetch: () => Effect.die("not fetched in this test")
})

describe("listPluginAlerts", () => {
  it.effect("tells a disabled official plugin from a tampered one and an inert third-party one", () =>
    Effect.gen(function*() {
      const repository = yield* PluginRepository.PluginRepository
      yield* repository.store({ ...plugin("disabled"), trust: "inert" })
      yield* repository.store({ ...plugin("tampered"), trust: "inert" })
      yield* repository.store({ ...plugin("imported"), trust: "inert", origin: { _tag: "Directory", path: "/plugins/imported" } })
      yield* repository.store(plugin("enabled"))

      const alerts = yield* listPluginAlerts

      expect(alerts).toEqual([
        { _tag: "WaitsForEnable", plugin: "imported" },
        { _tag: "DigestMismatch", plugin: "tampered" }
      ])
    }).pipe(Effect.provide(Layer.merge(layerRepositories, official))))
})
