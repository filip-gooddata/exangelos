import { Schema } from "effect"
import { EventId, EventNumber, EventType, SubscriptionId } from "./Ids.ts"

export const Event = Schema.Struct({
  id: EventId,
  subscription: SubscriptionId,
  number: EventNumber,
  type: EventType,
  occurredAt: Schema.DateTimeUtc,
  receivedAt: Schema.DateTimeUtc,
  summary: Schema.String,
  payload: Schema.Unknown,
  link: Schema.optionalKey(Schema.String),
  dedupeKey: Schema.NonEmptyString
})
export type Event = typeof Event.Type

export const ReportedEvent = Schema.Struct({
  type: EventType,
  occurredAt: Schema.DateTimeUtc,
  summary: Schema.String,
  payload: Schema.Unknown,
  link: Schema.optionalKey(Schema.String),
  dedupeKey: Schema.NonEmptyString
})
export type ReportedEvent = typeof ReportedEvent.Type

export const WatchItem = Schema.TaggedUnion({
  Event: { event: ReportedEvent, cursor: Schema.optionalKey(Schema.String) },
  Cursor: { cursor: Schema.String },
  /**
   * The subject is not readable yet, such as a conversation not yet in a local cache, and the stream waits
   * for it to appear. Not an event and not a failure; a later Cursor or Event clears it.
   */
  Pending: { reason: Schema.String, cursor: Schema.String },
  End: { reason: Schema.String }
})
export type WatchItem = typeof WatchItem.Type
