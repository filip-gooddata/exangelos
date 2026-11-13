import { Schema } from "effect"

export const SubscriptionId = Schema.String.check(Schema.isPattern(/^sub_[a-z0-9]+$/)).pipe(
  Schema.brand("SubscriptionId")
)
export type SubscriptionId = typeof SubscriptionId.Type

export const EventId = Schema.String.check(Schema.isPattern(/^evt_[a-z0-9]+$/)).pipe(Schema.brand("EventId"))
export type EventId = typeof EventId.Type

export const WakeId = Schema.String.check(Schema.isPattern(/^wake_[a-z0-9]+$/)).pipe(Schema.brand("WakeId"))
export type WakeId = typeof WakeId.Type

export const ConnectorName = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]*$/)).pipe(
  Schema.brand("ConnectorName")
)
export type ConnectorName = typeof ConnectorName.Type

export const EventType = Schema.String.check(Schema.isPattern(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/)).pipe(
  Schema.brand("EventType")
)
export type EventType = typeof EventType.Type

export const EventNumber = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
export type EventNumber = typeof EventNumber.Type

export const AckedThrough = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
export type AckedThrough = typeof AckedThrough.Type
