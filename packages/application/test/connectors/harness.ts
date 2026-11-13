import { DateTime, Effect, Layer, Option } from "effect"
import { Catalogue, Ids, Connector, Session, Subscription } from "@exangelos/domain"
import { layerConnectors, ConnectorDirectory, ConnectorRepository, SubscriptionRepository } from "@exangelos/application"
import {
  layerAlertSink,
  layerConnectorFiles,
  layerConnectorRuntime,
  layerRepositories,
  layerSecretStore,
  layerServiceManager,
  layerSettingsStore,
  layerSubscriptionIntake,
  connectorRoot,
  SubscriptionIntakeFake
} from "@exangelos/application/testing"

export const you: Session.Actor = { _tag: "You" }

export const name = (text: string) => Ids.ConnectorName.make(text)

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

export const installed = (connector: string, digest = "sha256-a", directory = `${connectorRoot}/${connector}`): ConnectorDirectory.Installed => ({
  name: name(connector),
  version: "1.0.0",
  directory,
  entry: { _tag: "Bundle", path: "main.js" },
  digest
})

/** Lets forked fibers run without moving the test clock. */
export const settle = Effect.forEach(Array.from({ length: 50 }), () => Effect.yieldNow, { discard: true })

export const connectorOf = (connector: string) =>
  Effect.flatMap(ConnectorRepository.ConnectorRepository, (r) => Effect.flatMap(r.find(name(connector)), Effect.fromOption))

export const changeKinds = (connector: string) =>
  Effect.flatMap(ConnectorRepository.ConnectorRepository, (r) =>
    Effect.map(r.changes(name(connector)), (all) => all.map((change) => [change.kind, change.actor._tag])))

/** How many times the intake heard that the connector is unavailable: once per episode, again at the wake limit. */
export const unavailableReports = (connector: string) =>
  Effect.gen(function*() {
    const changes = yield* (yield* SubscriptionIntakeFake).connectorChanges
    return changes.filter((p) => p.name === connector && p.unavailableSince !== undefined).length
  })

export const storeConnector = (connector: Connector.Connector) =>
  Effect.flatMap(ConnectorRepository.ConnectorRepository, (r) => r.store(connector))

export const activeSubscription = (
  connector: string,
  id: string,
  cursor?: string,
  parameters: Subscription.Subscription["parameters"] = { name: id }
) =>
  Effect.gen(function*() {
    const now = yield* DateTime.now
    const subscription: Subscription.Subscription = {
      id: Ids.SubscriptionId.make(id),
      connector: name(connector),
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
  layerConnectorRuntime,
  layerConnectorFiles(known),
  layerSecretStore,
  layerSettingsStore(),
  layerAlertSink,
  layerSubscriptionIntake,
  layerServiceManager({ method: "launch-agent", installed: true, running: true })
)

/** The connector half over the fakes. Build it after seeding stored connectors, since it starts them. */
export const layer = layerConnectors.pipe(Layer.provideMerge(ports))

export const withConnectors = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.provide(effect, layer)

/** The connector half over the fakes, with some ports replaced. */
export const withConnectorsOver = <ROut>(replaced: Layer.Layer<ROut>) => <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.provide(effect, layerConnectors.pipe(Layer.provideMerge(Layer.merge(ports, replaced))))

export const optionValue = Option.getOrThrow
