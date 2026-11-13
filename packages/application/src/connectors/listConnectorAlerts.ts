import { Effect, Option } from "effect"
import { ConnectorRules } from "@exangelos/domain"
import { OfficialConnectorSource } from "../ports/OfficialConnectorSource.ts"
import { ConnectorRepository } from "../ports/ConnectorRepository.ts"

export const listConnectorAlerts = Effect.gen(function*() {
  const { known } = yield* OfficialConnectorSource
  const connectors = yield* ConnectorRepository.use((repository) => repository.list)
  const checksum = (name: string) =>
    Option.map(Option.fromNullishOr(known.find((official) => official.name === name)), (official) => official.digest)
  return connectors.flatMap((connector) => Option.toArray(ConnectorRules.trustAlert(connector, checksum(connector.name))))
})
