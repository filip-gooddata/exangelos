import { DateTime, Effect, Layer, Option, Ref } from "effect"
import type { Catalogue, Event, Ids, Connector, Subscription, Wake } from "@exangelos/domain"
import { Delivery, Session } from "@exangelos/domain"
import { EventRepository } from "../ports/EventRepository.ts"
import { ConnectorRepository, type ConnectorChange } from "../ports/ConnectorRepository.ts"
import { SubscriptionRepository } from "../ports/SubscriptionRepository.ts"
import { WakeRepository } from "../ports/WakeRepository.ts"

interface Store {
  readonly connectors: ReadonlyMap<Ids.ConnectorName, Connector.Connector>
  readonly values: ReadonlyMap<Ids.ConnectorName, Catalogue.ConfigurationValues>
  readonly connectorChanges: ReadonlyArray<ConnectorChange>
  readonly subscriptions: ReadonlyMap<Ids.SubscriptionId, Subscription.Subscription>
  readonly changes: ReadonlyArray<Subscription.Change>
  readonly events: ReadonlyArray<Event.Event>
  readonly wakes: ReadonlyArray<Wake.Wake>
}

const empty: Store = {
  connectors: new Map(),
  values: new Map(),
  connectorChanges: [],
  subscriptions: new Map(),
  changes: [],
  events: [],
  wakes: []
}

const withEntry = <K, V>(map: ReadonlyMap<K, V>, key: K, value: V): ReadonlyMap<K, V> =>
  new Map(map).set(key, value)

const withoutEntry = <K, V>(map: ReadonlyMap<K, V>, key: K): ReadonlyMap<K, V> => {
  const next = new Map(map)
  next.delete(key)
  return next
}

/** The four repositories over one in-memory store, so writes that span them stay consistent. */
export const layerRepositories: Layer.Layer<
  ConnectorRepository | SubscriptionRepository | EventRepository | WakeRepository
> = Layer.unwrap(Effect.gen(function*() {
  const store = yield* Ref.make(empty)
  const read = <A>(f: (store: Store) => A) => Effect.map(Ref.get(store), f)
  const write = (f: (store: Store) => Store) => Ref.update(store, f)

  const connectors = Layer.succeed(ConnectorRepository, {
    find: (name) => read((s) => Option.fromNullishOr(s.connectors.get(name))),
    list: read((s) => [...s.connectors.values()].sort((a, b) => a.name.localeCompare(b.name))),
    store: (connector, change) =>
      write((s) => ({
        ...s,
        connectors: withEntry(s.connectors, connector.name, connector),
        connectorChanges: change === undefined ? s.connectorChanges : [...s.connectorChanges, change]
      })),
    remove: (name, change) =>
      write((s) => ({
        ...s,
        connectors: withoutEntry(s.connectors, name),
        values: withoutEntry(s.values, name),
        connectorChanges: [...s.connectorChanges, change]
      })),
    changes: (name) => read((s) => s.connectorChanges.filter((change) => change.connector === name)),
    values: (name) => read((s) => s.values.get(name) ?? {}),
    storeValues: (name, values) => write((s) => ({ ...s, values: withEntry(s.values, name, values) }))
  })

  const subscriptions = Layer.succeed(SubscriptionRepository, {
    find: (id) => read((s) => Option.fromNullishOr(s.subscriptions.get(id))),
    list: (filter) =>
      read((s) =>
        [...s.subscriptions.values()].filter((subscription) =>
          (filter.states === undefined || filter.states.includes(subscription.state._tag)) &&
          (filter.connector === undefined || filter.connector === subscription.connector) &&
          (filter.target === undefined ||
            (subscription.wakeTarget !== undefined && Session.sameSession(filter.target, subscription.wakeTarget)))
        ).sort((a, b) => DateTime.toEpochMillis(a.createdAt) - DateTime.toEpochMillis(b.createdAt))
      ),
    store: (subscription, change) =>
      write((s) => ({
        ...s,
        subscriptions: withEntry(s.subscriptions, subscription.id, subscription),
        changes: change === undefined ? s.changes : [...s.changes, change]
      })),
    changes: (id) => read((s) => s.changes.filter((change) => change.subscription === id)),
    remove: (ids) =>
      write((s) => ({
        ...s,
        subscriptions: new Map([...s.subscriptions].filter(([id]) => !ids.includes(id))),
        changes: s.changes.filter((change) => !ids.includes(change.subscription)),
        events: s.events.filter((event) => !ids.includes(event.subscription)),
        wakes: s.wakes.filter((wake) => !ids.includes(wake.subscription))
      }))
  })

  const events = Layer.succeed(EventRepository, {
    append: (subscription, appended) =>
      write((s) => ({
        ...s,
        subscriptions: withEntry(s.subscriptions, subscription.id, subscription),
        events: [...s.events, ...appended]
      })),
    list: (subscription, after = 0) =>
      read((s) =>
        s.events
          .filter((event) => event.subscription === subscription && event.number > after)
          .sort((a, b) => a.number - b.number)
      ),
    findByDedupeKey: (subscription, dedupeKey) =>
      read((s) =>
        Option.fromNullishOr(
          s.events.find((event) => event.subscription === subscription && event.dedupeKey === dedupeKey)
        )
      )
  })

  const wakes = Layer.succeed(WakeRepository, {
    add: (wake) =>
      write((s) => ({
        ...s,
        wakes: [
          ...s.wakes.map((other) =>
            other.subscription === wake.subscription && Delivery.isUndelivered(other)
              ? { ...other, state: "replaced" as const }
              : other
          ),
          wake
        ]
      })),
    update: (wake) => write((s) => ({ ...s, wakes: s.wakes.map((other) => other.id === wake.id ? wake : other) })),
    list: (subscription) => read((s) => s.wakes.filter((wake) => wake.subscription === subscription)),
    findUndelivered: (subscription) =>
      read((s) => Option.fromNullishOr(s.wakes.find((wake) => wake.subscription === subscription && Delivery.isUndelivered(wake)))),
    listUndelivered: read((s) => s.wakes.filter(Delivery.isUndelivered))
  })

  return Layer.mergeAll(connectors, subscriptions, events, wakes)
}))
