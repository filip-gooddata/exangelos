import { Context, Schema } from "effect"
import type { Effect } from "effect"
import { Alert as DomainAlert } from "@exangelos/domain"

export const Alert = DomainAlert.Alert
export type Alert = typeof Alert.Type

export class AlertFailed extends Schema.TaggedError<AlertFailed>()("AlertFailed", {
  reason: Schema.String
}) {}

export class AlertSink extends Context.Service<AlertSink, {
  /** Renders the alert text and shows it as a desktop notification. */
  readonly show: (alert: Alert) => Effect.Effect<void, AlertFailed>
}>()("@exangelos/application/AlertSink") {}
