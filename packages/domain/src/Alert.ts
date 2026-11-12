import { Option, Schema } from "effect"
import { type Event, Event as EventRecord } from "./Event.ts"
import { PluginName, SubscriptionId } from "./Ids.ts"
import type { Settings } from "./Settings.ts"
import type { Subscription } from "./Subscription.ts"

export const Alert = Schema.TaggedUnion({
  WaitsForEnable: { plugin: PluginName },
  Failing: { plugin: PluginName, reason: Schema.String },
  CredentialsRejected: { plugin: PluginName, reason: Schema.String },
  DigestMismatch: { plugin: PluginName },
  Event: { subscription: SubscriptionId, plugin: PluginName, subject: Schema.String, event: EventRecord }
})
export type Alert = typeof Alert.Type

export const forEvent = (settings: Settings, subscription: Subscription, event: Event): Option.Option<Alert> =>
  settings.eventAlerts || subscription.eventAlerts
    ? Option.some({
      _tag: "Event",
      subscription: subscription.id,
      plugin: subscription.plugin,
      subject: subscription.subject,
      event
    })
    : Option.none()
