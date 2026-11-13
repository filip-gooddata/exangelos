import { Layer } from "effect"
import { layerConnectorAccess } from "./layerConnectorAccess.ts"
import { layerConnectorSupervisor } from "./ConnectorSupervisor.ts"

/** The connector half running inside the daemon: supervision, file watch and the real ConnectorAccess. */
export const layerConnectors = layerConnectorAccess.pipe(Layer.provideMerge(layerConnectorSupervisor))
