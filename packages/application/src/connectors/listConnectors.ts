import { Effect } from "effect"
import { ConnectorRepository } from "../ports/ConnectorRepository.ts"

/** Every known connector by name; a connector that has never run has no catalogue yet. */
export const listConnectors = Effect.gen(function*() {
  const repository = yield* ConnectorRepository
  return yield* repository.list
})
