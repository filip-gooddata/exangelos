import { Catalogue, Ids, Connector } from "@exangelos/domain"

export const catalogue: Catalogue.Catalogue = {
  eventTypes: [{ type: Ids.EventType.make("tick"), description: "a tick", payload: {} }],
  parameters: { main: "name", schema: {} },
  configuration: []
}

export const connector = (name: string): Connector.Connector => ({
  name: Ids.ConnectorName.make(name),
  version: "1.0.0",
  origin: { _tag: "Official", version: "1.0.0" },
  digest: "sha256-test",
  trust: "enabled",
  catalogue,
  configuration: { _tag: "Set" },
  process: "running"
})
