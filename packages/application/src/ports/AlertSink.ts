import { Context, Schema } from "effect"
import type { Effect } from "effect"
import { Event, Ids } from "@exangelos/domain"

export const Alert = Schema.TaggedUnion({
  WaitsForEnable: { plugin: Ids.PluginName },
  Failing: { plugin: Ids.PluginName, reason: Schema.String },
  CredentialsRejected: { plugin: Ids.PluginName, reason: Schema.String },
  DigestMismatch: { plugin: Ids.PluginName },
  Event: { subscription: Ids.SubscriptionId, plugin: Ids.PluginName, subject: Schema.String, event: Event.Event }
})
export type Alert = typeof Alert.Type

export class AlertFailed extends Schema.TaggedError<AlertFailed>()("AlertFailed", {
  reason: Schema.String
}) {}

export class AlertSink extends Context.Service<AlertSink, {
  /** Renders the alert text and shows it as a desktop notification. */
  readonly show: (alert: Alert) => Effect.Effect<void, AlertFailed>
}>()("@exangelos/application/AlertSink") {}
