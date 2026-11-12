import { DateTime, Effect, Layer, Option } from "effect"
import { Catalogue, Ids, Plugin, Session, Subscription } from "@exangelos/domain"
import { layerPlugins, PluginDirectory, PluginRepository, SubscriptionRepository } from "@exangelos/application"
import {
  layerAlertSink,
  layerPluginFiles,
  layerPluginRuntime,
  layerRepositories,
  layerSecretStore,
  layerServiceManager,
  layerSettingsStore,
  layerSubscriptionIntake,
  pluginRoot,
  SubscriptionIntakeFake
} from "@exangelos/application/testing"

export const you: Session.Actor = { _tag: "You" }

export const name = (text: string) => Ids.PluginName.make(text)

export const officialDigest = "sha256-official"

export const known = [{ name: name("github-pr"), version: "1.0.0", digest: officialDigest }]

export const tick = Ids.EventType.make("tick")

export const catalogue = (configuration: ReadonlyArray<Catalogue.ConfigurationField> = []): Catalogue.Catalogue => ({
  eventTypes: [{ type: tick, description: "a tick", payload: {} }],
  parameters: { main: "name", schema: {} },
  configuration
})

export const hostAndToken: ReadonlyArray<Catalogue.ConfigurationField> = [
  { _tag: "Text", key: "host", label: "Host", required: true, secretDestination: true },
  { _tag: "Secret", key: "token", label: "Token", required: true }
]

export const installed = (plugin: string, digest = "sha256-a", directory = `${pluginRoot}/${plugin}`): PluginDirectory.Installed => ({
  name: name(plugin),
  version: "1.0.0",
  directory,
  entry: { _tag: "Bundle", path: "main.js" },
  digest
})

/** Lets forked fibers run without moving the test clock. */
export const settle = Effect.forEach(Array.from({ length: 50 }), () => Effect.yieldNow, { discard: true })

export const pluginOf = (plugin: string) =>
  Effect.flatMap(PluginRepository.PluginRepository, (r) => Effect.flatMap(r.find(name(plugin)), Effect.fromOption))

export const changeKinds = (plugin: string) =>
  Effect.flatMap(PluginRepository.PluginRepository, (r) =>
    Effect.map(r.changes(name(plugin)), (all) => all.map((change) => [change.kind, change.actor._tag])))

/** How many times the intake heard that the plugin is unavailable: once per episode, again at the wake limit. */
export const unavailableReports = (plugin: string) =>
  Effect.gen(function*() {
    const changes = yield* (yield* SubscriptionIntakeFake).pluginChanges
    return changes.filter((p) => p.name === plugin && p.unavailableSince !== undefined).length
  })

export const storePlugin = (plugin: Plugin.Plugin) =>
  Effect.flatMap(PluginRepository.PluginRepository, (r) => r.store(plugin))

export const activeSubscription = (
  plugin: string,
  id: string,
  cursor?: string,
  parameters: Subscription.Subscription["parameters"] = { name: id }
) =>
  Effect.gen(function*() {
    const now = yield* DateTime.now
    const subscription: Subscription.Subscription = {
      id: Ids.SubscriptionId.make(id),
      plugin: name(plugin),
      parameters,
      subject: id,
      label: id,
      intent: "test",
      createdAt: now,
      expiresAt: DateTime.add(now, { days: 7 }),
      state: { _tag: "Active" },
      stateSince: now,
      lastNumber: 0,
      ackedThrough: 0,
      eventAlerts: false,
      ...(cursor === undefined ? {} : { cursor })
    }
    yield* Effect.flatMap(SubscriptionRepository.SubscriptionRepository, (r) => r.store(subscription))
    return subscription.id
  })

const ports = Layer.mergeAll(
  layerRepositories,
  layerPluginRuntime,
  layerPluginFiles(known),
  layerSecretStore,
  layerSettingsStore(),
  layerAlertSink,
  layerSubscriptionIntake,
  layerServiceManager({ method: "launch-agent", installed: true, running: true })
)

/** The plugin half over the fakes. Build it after seeding stored plugins, since it starts them. */
export const layer = layerPlugins.pipe(Layer.provideMerge(ports))

export const withPlugins = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.provide(effect, layer)

/** The plugin half over the fakes, with some ports replaced. */
export const withPluginsOver = <ROut>(replaced: Layer.Layer<ROut>) => <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.provide(effect, layerPlugins.pipe(Layer.provideMerge(Layer.merge(ports, replaced))))

export const optionValue = Option.getOrThrow
