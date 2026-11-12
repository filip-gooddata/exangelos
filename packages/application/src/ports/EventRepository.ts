import { Context } from "effect"
import type { Effect, Option } from "effect"
import type { Event, Ids, Subscription } from "@exangelos/domain"

export class EventRepository extends Context.Service<EventRepository, {
  /**
   * Stores the events and the subscription in one write, so its cursor and last number never
   * run ahead of or behind its events. The caller numbers the events from the subscription's
   * last number.
   */
  readonly append: (
    subscription: Subscription.Subscription,
    events: ReadonlyArray<Event.Event>
  ) => Effect.Effect<void>
  /** Events numbered above `after` (all when omitted), by number. */
  readonly list: (
    subscription: Ids.SubscriptionId,
    after?: Ids.AckedThrough
  ) => Effect.Effect<ReadonlyArray<Event.Event>>
  readonly findByDedupeKey: (
    subscription: Ids.SubscriptionId,
    dedupeKey: string
  ) => Effect.Effect<Option.Option<Event.Event>>
}>()("@exangelos/application/EventRepository") {}
