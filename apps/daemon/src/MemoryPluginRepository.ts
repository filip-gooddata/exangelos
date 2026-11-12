import { PluginRepository } from "@exangelos/application"
import type { Catalogue, Ids, Plugin } from "@exangelos/domain"
import { Effect, HashMap, Layer, Option, Order, Ref } from "effect"

interface State {
  readonly plugins: HashMap.HashMap<Ids.PluginName, Plugin.Plugin>
  readonly values: HashMap.HashMap<Ids.PluginName, Catalogue.ConfigurationValues>
  readonly changes: ReadonlyArray<PluginRepository.PluginChange>
}

const byName = Order.mapInput(Order.String, (plugin: Plugin.Plugin) => plugin.name)

/** First cut: keeps plugin records in memory until the sqlite repositories land. */
export const layer = Layer.effect(
  PluginRepository.PluginRepository,
  Effect.gen(function*() {
    const state = yield* Ref.make<State>({ plugins: HashMap.empty(), values: HashMap.empty(), changes: [] })
    const record = (change: PluginRepository.PluginChange | undefined) => (changes: State["changes"]) =>
      change === undefined ? changes : [...changes, change]
    return PluginRepository.PluginRepository.of({
      find: (name) => Ref.get(state).pipe(Effect.map((s) => HashMap.get(s.plugins, name))),
      list: Ref.get(state).pipe(Effect.map((s) => Array.from(HashMap.values(s.plugins)).sort(byName))),
      store: (plugin, change) =>
        Ref.update(state, (s) => ({
          ...s,
          plugins: HashMap.set(s.plugins, plugin.name, plugin),
          changes: record(change)(s.changes)
        })),
      remove: (name, change) =>
        Ref.update(state, (s) => ({
          plugins: HashMap.remove(s.plugins, name),
          values: HashMap.remove(s.values, name),
          changes: record(change)(s.changes)
        })),
      changes: (name) => Ref.get(state).pipe(Effect.map((s) => s.changes.filter((c) => c.plugin === name))),
      values: (name) =>
        Ref.get(state).pipe(Effect.map((s) => Option.getOrElse(HashMap.get(s.values, name), () => ({})))),
      storeValues: (name, values) =>
        Ref.update(state, (s) => ({ ...s, values: HashMap.set(s.values, name, values) }))
    })
  })
)
