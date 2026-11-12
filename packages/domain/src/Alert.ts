import { Option, Schema } from "effect"
import type { Event } from "./Event.ts"
import { EventNumber, PluginName, SubscriptionId } from "./Ids.ts"
import type { Settings } from "./Settings.ts"
import type { Subscription } from "./Subscription.ts"

export const Alert = Schema.TaggedUnion({
  WaitingToBeEnabled: { plugin: PluginName },
  KeepsFailing: { plugin: PluginName },
  CredentialsRejected: { plugin: PluginName, reason: Schema.String },
  ChecksumMismatch: { plugin: PluginName },
  Event: { subscription: SubscriptionId, number: EventNumber, summary: Schema.String }
})
export type Alert = typeof Alert.Type

export const forEvent = (settings: Settings, subscription: Subscription, event: Event): Option.Option<Alert> =>
  settings.eventAlerts || subscription.eventAlerts
    ? Option.some({ _tag: "Event", subscription: subscription.id, number: event.number, summary: event.summary })
    : Option.none()
