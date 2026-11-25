import { Schema } from "effect"
import { ObservationFailure } from "./Connector.ts"
import { AckedThrough, SubscriptionId, WakeId } from "./Ids.ts"
import { Actor } from "./Session.ts"
import { EndReason, PauseReason } from "./Subscription.ts"

export const WakeReason = Schema.Literals(["events", "paused", "expired", "suspended", "failing", "recovered", "ended", "cancelled"])
export type WakeReason = typeof WakeReason.Type

export const WakeState = Schema.Literals(["waiting", "sending", "delivered", "replaced", "dropped"])
export type WakeState = typeof WakeState.Type

export const Attempts = Schema.Struct({
  count: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  lastError: Schema.optionalKey(Schema.String),
  nextAttemptAt: Schema.optionalKey(Schema.DateTimeUtc)
})
export type Attempts = typeof Attempts.Type

export const Wake = Schema.Struct({
  id: WakeId,
  subscription: SubscriptionId,
  reason: WakeReason,
  through: AckedThrough,
  state: WakeState,
  attempts: Attempts,
  createdAt: Schema.DateTimeUtc
})
export type Wake = typeof Wake.Type

export const PendingLine = Schema.Struct({
  number: Schema.Int,
  type: Schema.String,
  summary: Schema.String
})
export type PendingLine = typeof PendingLine.Type

export const Why = Schema.TaggedUnion({
  Events: {},
  Paused: { reason: PauseReason },
  Expired: {},
  Ended: { reason: EndReason },
  Cancelled: { actor: Actor },
  Suspended: { since: Schema.DateTimeUtc, problem: Schema.String },
  Failing: ObservationFailure.fields,
  Recovered: {}
})
export type Why = typeof Why.Type

export const WakeContent = Schema.Struct({
  subscription: SubscriptionId,
  connector: Schema.String,
  subject: Schema.String,
  why: Why,
  pending: Schema.Array(PendingLine)
})
export type WakeContent = typeof WakeContent.Type
