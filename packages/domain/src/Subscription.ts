import { Schema } from "effect"
import { Parameters } from "./Catalogue.ts"
import { AckedThrough, EventType, ConnectorName, SubscriptionId } from "./Ids.ts"
import { ObservationFailure, ObservationOutage } from "./Connector.ts"
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
  /**
   * Why the connector waits for the subject to appear, from its latest Pending item, scrubbed of secrets
   * and bounded. Absent once a Cursor or Event follows. Never logged.
   */
  waiting: Schema.optionalKey(Schema.String),
  lastNumber: AckedThrough,
  ackedThrough: AckedThrough,
  eventAlerts: Schema.Boolean
})
export type Subscription = typeof Subscription.Type

/** A subscription as list reports it: the stored record and, while its source keeps failing, since when. */
export const Listed = Schema.Struct({
  ...Subscription.fields,
  observation: Schema.optionalKey(ObservationOutage)
})
export type Listed = typeof Listed.Type

/** A subscription as show reports it: like Listed, with the failure's reason. */
export const Shown = Schema.Struct({
  ...Subscription.fields,
  observation: Schema.optionalKey(ObservationFailure)
})
export type Shown = typeof Shown.Type

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
