import { Layer } from "effect"
import {
  layerAlertSink,
  layerPluginAccess,
  layerRepositories,
  layerSettingsStore,
  layerWakeTarget
} from "@exangelos/application/testing"
import { layerSubscriptionLocks } from "../../src/subscriptions/Locks.ts"
import { layerSubscriptionSignals } from "../../src/subscriptions/Signals.ts"

/** Every port the subscription half uses, as in-memory fakes. Tests run under the test clock. */
export const layerHarness = Layer.mergeAll(
  layerRepositories,
  layerSettingsStore(),
  layerWakeTarget,
  layerPluginAccess,
  layerAlertSink,
  layerSubscriptionSignals,
  layerSubscriptionLocks
)
