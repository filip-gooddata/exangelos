import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { listConnectorAlerts, OfficialConnectorSource, ConnectorRepository } from "@exangelos/application"
import { layerRepositories } from "@exangelos/application/testing"
import { connector } from "../fixtures.ts"

const official = Layer.succeed(OfficialConnectorSource.OfficialConnectorSource)({
  known: [
    { name: connector("disabled").name, version: "1.0.0", digest: "sha256-test" },
    { name: connector("tampered").name, version: "1.0.0", digest: "sha256-release" }
  ],
  fetch: () => Effect.die("not fetched in this test"),
  replace: () => Effect.die("not replaced in this test")
})

describe("listConnectorAlerts", () => {
  it.effect("tells a disabled official connector from a tampered one and an inert third-party one", () =>
    Effect.gen(function*() {
      const repository = yield* ConnectorRepository.ConnectorRepository
      yield* repository.store({ ...connector("disabled"), trust: "inert" })
      yield* repository.store({ ...connector("tampered"), trust: "inert" })
      yield* repository.store({ ...connector("imported"), trust: "inert", origin: { _tag: "Directory", path: "/connectors/imported" } })
      yield* repository.store(connector("enabled"))

      const alerts = yield* listConnectorAlerts

      expect(alerts).toEqual([
        { _tag: "WaitsForEnable", connector: "imported" },
        { _tag: "DigestMismatch", connector: "tampered" }
      ])
    }).pipe(Effect.provide(Layer.merge(layerRepositories, official))))
})
