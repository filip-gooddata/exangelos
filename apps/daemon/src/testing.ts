import {
  layerAlertSink,
  layerSecretStore,
  layerServiceManager,
  layerSessionTitles,
  layerWakeTarget
} from "@exangelos/application/testing"
import * as Daemon from "./Daemon.ts"

export const fakes: Pick<Daemon.Options, "alerts" | "serviceManager" | "secretStore" | "wakeTarget" | "sessionTitles"> = {
  alerts: layerAlertSink,
  serviceManager: layerServiceManager({ method: "launch-agent", installed: true, running: true }),
  secretStore: layerSecretStore,
  wakeTarget: layerWakeTarget,
  sessionTitles: layerSessionTitles
}

export const layerForTests = Daemon.layer({ ...fakes, officialConnectors: [], releaseUrl: undefined })
