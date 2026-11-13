import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { listConnectors, ConnectorRepository } from "@exangelos/application"
import { layerRepositories } from "@exangelos/application/testing"
import { catalogue, connector } from "./fixtures.ts"

describe("listConnectors", () => {
  it.effect("lists every stored connector by name with its catalogue", () =>
    Effect.gen(function*() {
      const repository = yield* ConnectorRepository.ConnectorRepository
      yield* repository.store(connector("template"))
      yield* repository.store(connector("github-pr"))

      const connectors = yield* listConnectors

      expect(connectors.map((p) => [p.name, p.catalogue])).toEqual([
        ["github-pr", catalogue],
        ["template", catalogue]
      ])
    }).pipe(Effect.provide(layerRepositories)))
})
