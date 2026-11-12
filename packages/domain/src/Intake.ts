import { type DateTime, Option } from "effect"
import type { Event, ReportedEvent } from "./Event.ts"
import type { EventId } from "./Ids.ts"
import type { Subscription } from "./Subscription.ts"
import type { Why } from "./Wake.ts"

export interface Report {
  readonly subscription: Subscription
  readonly reported: ReportedEvent
  readonly cursor: Option.Option<string>
  readonly duplicate: boolean
  readonly id: EventId
  readonly now: DateTime.Utc
}

export interface Admission {
  readonly subscription: Subscription
  readonly event: Option.Option<Event>
  readonly wake: Option.Option<Why>
}

export const isSelected = (subscription: Subscription, reported: ReportedEvent): boolean =>
  subscription.eventTypes === undefined || subscription.eventTypes.includes(reported.type)

export const admit = ({ cursor, duplicate, id, now, reported, subscription }: Report): Admission => {
  if (subscription.state._tag !== "Active") {
    return { subscription, event: Option.none(), wake: Option.none() }
  }
  const moved = Option.match(cursor, { onNone: () => subscription, onSome: (c) => ({ ...subscription, cursor: c }) })
  if (duplicate || !isSelected(subscription, reported)) {
    return { subscription: moved, event: Option.none(), wake: Option.none() }
  }
  const number = subscription.lastNumber + 1
  const event: Event = { ...reported, id, subscription: subscription.id, number, receivedAt: now }
  const numbered: Subscription = { ...moved, lastNumber: number }
  if (subscription.maxEvents !== undefined && number >= subscription.maxEvents) {
    return {
      subscription: { ...numbered, state: { _tag: "Ended", reason: { _tag: "MaxEvents" } }, stateSince: now },
      event: Option.some(event),
      wake: Option.some({ _tag: "Ended", reason: { _tag: "MaxEvents" } })
    }
  }
  return { subscription: numbered, event: Option.some(event), wake: Option.some({ _tag: "Events" }) }
}

export const acknowledge = (subscription: Subscription, through: number): Subscription => ({
  ...subscription,
  ackedThrough: Math.max(subscription.ackedThrough, Math.min(through, subscription.lastNumber))
})

export const isPending = (subscription: Subscription, number: number): boolean => number > subscription.ackedThrough
