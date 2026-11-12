import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { listPlugins, PluginRepository } from "@exangelos/application"
import { layerRepositories } from "@exangelos/application/testing"
import { catalogue, plugin } from "./fixtures.ts"

describe("listPlugins", () => {
  it.effect("lists every stored plugin by name with its catalogue", () =>
    Effect.gen(function*() {
      const repository = yield* PluginRepository.PluginRepository
      yield* repository.store(plugin("template"))
      yield* repository.store(plugin("github-pr"))

      const plugins = yield* listPlugins

      expect(plugins.map((p) => [p.name, p.catalogue])).toEqual([
        ["github-pr", catalogue],
        ["template", catalogue]
      ])
    }).pipe(Effect.provide(layerRepositories)))
})
