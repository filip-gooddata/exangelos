import { Effect } from "effect"
import { PluginRepository } from "../ports/PluginRepository.ts"

/** Every known plugin by name; a plugin that has never run has no catalogue yet. */
export const listPlugins = Effect.gen(function*() {
  const repository = yield* PluginRepository
  return yield* repository.list
})
