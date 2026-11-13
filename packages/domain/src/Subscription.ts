import { Schema } from "effect"
import { Parameters } from "./Catalogue.ts"
import { AckedThrough, EventType, ConnectorName, SubscriptionId } from "./Ids.ts"
import { Actor, Target } from "./Session.ts"

export const PauseReason = Schema.TaggedUnion({
  BacklogCount: { limit: Schema.Int },
  BacklogAge: { limit: Schema.DurationFromMillis },
  Actor: { actor: Actor }
})
export type PauseReason = typeof PauseReason.Type

export const EndReason = Schema.TaggedUnion({
  Connector: { reason: Schema.String },
  MaxEvents: {}
})
export type EndReason = typeof EndReason.Type

export const State = Schema.TaggedUnion({
  Active: {},
  Paused: { reason: PauseReason },
  Expired: {},
  Ended: { reason: EndReason },
  Cancelled: { actor: Actor }
})
export type State = typeof State.Type

export const Subscription = Schema.Struct({
  id: SubscriptionId,
  connector: ConnectorName,
  parameters: Parameters,
  subject: Schema.NonEmptyString,
  label: Schema.String,
  intent: Schema.NonEmptyString,
  eventTypes: Schema.optionalKey(Schema.NonEmptyArray(EventType)),
  wakeTarget: Schema.optionalKey(Target),
  createdAt: Schema.DateTimeUtc,
  expiresAt: Schema.DateTimeUtc,
  maxEvents: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  state: State,
  stateSince: Schema.DateTimeUtc,
  cursor: Schema.optionalKey(Schema.String),
  lastNumber: AckedThrough,
  ackedThrough: AckedThrough,
  eventAlerts: Schema.Boolean
})
export type Subscription = typeof Subscription.Type

export const ChangeKind = Schema.Literals(["create", "update", "ack", "pause", "resume", "retarget", "cancel", "eventAlerts"])
export type ChangeKind = typeof ChangeKind.Type

export const Change = Schema.Struct({
  subscription: SubscriptionId,
  kind: ChangeKind,
  actor: Actor,
  at: Schema.DateTimeUtc,
  detail: Schema.optionalKey(Schema.String)
})
export type Change = typeof Change.Type
