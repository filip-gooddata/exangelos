import { Context } from "effect"
import type { Effect, Option } from "effect"
import type { Ids, Session, Subscription } from "@exangelos/domain"

export interface Filter {
  readonly states?: ReadonlyArray<Subscription.State["_tag"]>
  readonly connector?: Ids.ConnectorName
  readonly target?: Session.Session
}

export class SubscriptionRepository extends Context.Service<SubscriptionRepository, {
  readonly find: (id: Ids.SubscriptionId) => Effect.Effect<Option.Option<Subscription.Subscription>>
  /** Subscriptions matching every given criterion, oldest first. */
  readonly list: (filter: Filter) => Effect.Effect<ReadonlyArray<Subscription.Subscription>>
  /** Inserts or replaces the subscription and appends the change, if any, in one write. */
  readonly store: (subscription: Subscription.Subscription, change?: Subscription.Change) => Effect.Effect<void>
  /** Oldest first. */
  readonly changes: (id: Ids.SubscriptionId) => Effect.Effect<ReadonlyArray<Subscription.Change>>
  /** Deletes the subscriptions with their changes, events and wakes. */
  readonly remove: (ids: ReadonlyArray<Ids.SubscriptionId>) => Effect.Effect<void>
}>()("@exangelos/application/SubscriptionRepository") {}
