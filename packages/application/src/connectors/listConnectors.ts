import { Effect, Option } from "effect"
import { ConnectorDirectory } from "../ports/ConnectorDirectory.ts"
import { ConnectorRepository } from "../ports/ConnectorRepository.ts"
import { ConnectorSupervisor } from "./ConnectorSupervisor.ts"

/** Every known connector by name with its logo; a connector that has never run has no catalogue yet. */
export const listConnectors = Effect.gen(function*() {
  const repository = yield* ConnectorRepository
  const supervisor = yield* ConnectorSupervisor
  const directory = yield* ConnectorDirectory
  return yield* Effect.forEach(yield* repository.list, (connector) =>
    directory.icon(connector.name, connector.origin._tag === "DevLink" ? connector.origin.path : undefined).pipe(
      Effect.map((icon) => {
        const status = supervisor.status(connector)
        return Option.isSome(icon) ? { ...status, icon: icon.value } : status
      })
    ), { concurrency: 8 })
})
