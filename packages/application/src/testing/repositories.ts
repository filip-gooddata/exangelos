import { DateTime, Effect, Layer, Option, Ref } from "effect"
import type { Catalogue, Event, Ids, Plugin, Subscription, Wake } from "@exangelos/domain"
import { Session } from "@exangelos/domain"
import { EventRepository } from "../ports/EventRepository.ts"
import { PluginRepository, type PluginChange } from "../ports/PluginRepository.ts"
import { SubscriptionRepository } from "../ports/SubscriptionRepository.ts"
import { WakeRepository } from "../ports/WakeRepository.ts"

interface Store {
  readonly plugins: ReadonlyMap<Ids.PluginName, Plugin.Plugin>
  readonly values: ReadonlyMap<Ids.PluginName, Catalogue.ConfigurationValues>
  readonly pluginChanges: ReadonlyArray<PluginChange>
  readonly subscriptions: ReadonlyMap<Ids.SubscriptionId, Subscription.Subscription>
  readonly changes: ReadonlyArray<Subscription.Change>
  readonly events: ReadonlyArray<Event.Event>
  readonly wakes: ReadonlyArray<Wake.Wake>
}

const empty: Store = {
  plugins: new Map(),
  values: new Map(),
  pluginChanges: [],
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

const undelivered = (wake: Wake.Wake) => wake.state === "waiting" || wake.state === "sending"

/** The four repositories over one in-memory store, so writes that span them stay consistent. */
export const layerRepositories: Layer.Layer<
  PluginRepository | SubscriptionRepository | EventRepository | WakeRepository
> = Layer.unwrap(Effect.gen(function*() {
  const store = yield* Ref.make(empty)
  const read = <A>(f: (store: Store) => A) => Effect.map(Ref.get(store), f)
  const write = (f: (store: Store) => Store) => Ref.update(store, f)

  const plugins = Layer.succeed(PluginRepository, {
    find: (name) => read((s) => Option.fromNullishOr(s.plugins.get(name))),
    list: read((s) => [...s.plugins.values()].sort((a, b) => a.name.localeCompare(b.name))),
    store: (plugin, change) =>
      write((s) => ({
        ...s,
        plugins: withEntry(s.plugins, plugin.name, plugin),
        pluginChanges: change === undefined ? s.pluginChanges : [...s.pluginChanges, change]
      })),
    remove: (name, change) =>
      write((s) => ({
        ...s,
        plugins: withoutEntry(s.plugins, name),
        values: withoutEntry(s.values, name),
        pluginChanges: [...s.pluginChanges, change]
      })),
    changes: (name) => read((s) => s.pluginChanges.filter((change) => change.plugin === name)),
    values: (name) => read((s) => s.values.get(name) ?? {}),
    storeValues: (name, values) => write((s) => ({ ...s, values: withEntry(s.values, name, values) }))
  })

  const subscriptions = Layer.succeed(SubscriptionRepository, {
    find: (id) => read((s) => Option.fromNullishOr(s.subscriptions.get(id))),
    list: (filter) =>
      read((s) =>
        [...s.subscriptions.values()].filter((subscription) =>
          (filter.states === undefined || filter.states.includes(subscription.state._tag)) &&
          (filter.plugin === undefined || filter.plugin === subscription.plugin) &&
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
            other.subscription === wake.subscription && undelivered(other)
              ? { ...other, state: "replaced" as const }
              : other
          ),
          wake
        ]
      })),
    update: (wake) => write((s) => ({ ...s, wakes: s.wakes.map((other) => other.id === wake.id ? wake : other) })),
    list: (subscription) => read((s) => s.wakes.filter((wake) => wake.subscription === subscription)),
    findUndelivered: (subscription) =>
      read((s) => Option.fromNullishOr(s.wakes.find((wake) => wake.subscription === subscription && undelivered(wake)))),
    listUndelivered: read((s) => s.wakes.filter(undelivered))
  })

  return Layer.mergeAll(plugins, subscriptions, events, wakes)
}))
