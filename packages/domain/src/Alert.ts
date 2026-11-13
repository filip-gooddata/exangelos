import { Option, Schema } from "effect"
import { type Event, Event as EventRecord } from "./Event.ts"
import { ConnectorName, SubscriptionId } from "./Ids.ts"
import type { Settings } from "./Settings.ts"
import type { Subscription } from "./Subscription.ts"

export const Alert = Schema.TaggedUnion({
  WaitsForEnable: { connector: ConnectorName },
  Failing: { connector: ConnectorName, reason: Schema.String },
  CredentialsRejected: { connector: ConnectorName, reason: Schema.String },
  DigestMismatch: { connector: ConnectorName },
  Event: { subscription: SubscriptionId, connector: ConnectorName, subject: Schema.String, event: EventRecord }
})
export type Alert = typeof Alert.Type

export const forEvent = (settings: Settings, subscription: Subscription, event: Event): Option.Option<Alert> =>
  settings.eventAlerts || subscription.eventAlerts
    ? Option.some({
      _tag: "Event",
      subscription: subscription.id,
      connector: subscription.connector,
      subject: subscription.subject,
      event
    })
    : Option.none()
