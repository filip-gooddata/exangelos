import {
  type AlertSink,
  layerConnectors,
  layerRemovedConnectors,
  layerSubscriptionIntake,
  layerSubscriptionLocks,
  layerSubscriptionSignals,
  OfficialConnectorSource,
  runSubscriptionDaemon,
  SecretStore,
  ServiceManager,
  SubscriptionIntake,
  SettingsStore,
  type WakeTarget
} from "@exangelos/application"
import * as Alerts from "@exangelos/alerts"
import { DaemonContract } from "@exangelos/contracts"
import { DaemonServer } from "@exangelos/daemon-client"
import { FileLog, Level, Secrets } from "@exangelos/logging"
import { layerLinux, layerMacOS } from "@exangelos/notifications"
import * as OfficialConnectors from "@exangelos/official-connectors"
import { Paths } from "@exangelos/paths"
import * as ConnectorDirectoryLive from "@exangelos/connector-directory"
import * as ConnectorImport from "@exangelos/connector-import"
import { StdioConnectorRuntime } from "@exangelos/connector-runtime"
import { SecretStores } from "@exangelos/secrets"
import * as Service from "@exangelos/service"
import { SettingsFile } from "@exangelos/settings"
import { Database, Repositories } from "@exangelos/sqlite"
import * as WakeTargets from "@exangelos/wake-targets"
import { Context, Deferred, Effect, FileSystem, Layer, Option, Path, Redacted, Schema } from "effect"
import { ChildProcessSpawner } from "effect/process"
import { RpcServer } from "effect/rpc"
import * as Handlers from "./Handlers.ts"

export const DaemonAlreadyRunning = DaemonServer.DaemonAlreadyRunning
export type DaemonAlreadyRunning = DaemonServer.DaemonAlreadyRunning

export type Platform = FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner | Paths.Paths

export interface Choices {
  readonly alerts: Layer.Layer<AlertSink.AlertSink, never, Platform>
  readonly serviceManager: Layer.Layer<ServiceManager.ServiceManager, never, Platform>
  readonly secretStore: Layer.Layer<SecretStore.SecretStore, never, Platform>
  readonly wakeTarget: Layer.Layer<WakeTarget.WakeTarget, never, Platform | SettingsStore.SettingsStore>
}

export interface Options extends Choices {
  readonly officialConnectors: ReadonlyArray<unknown>
  readonly releaseUrl: string | undefined
  readonly runtime?: StdioConnectorRuntime.Options | undefined
  readonly version?: string | undefined
}

const unavailable = (failure: ServiceManager.ServiceFailed) =>
  ServiceManager.ServiceManager.of({ status: Effect.fail(failure), install: Effect.fail(failure), start: Effect.fail(failure) })

export const serviceManager = (
  options: Service.ServiceManager.Options
): Layer.Layer<ServiceManager.ServiceManager, never, Platform> =>
  Service.ServiceManager.layer.pipe(
    Layer.provide(Service.ServiceManager.layerUserService(options)),
    Layer.provide(Service.ServiceManager.layerInstallation(options)),
    Layer.catchTag("ConfigError", (error) =>
      Layer.succeed(
        ServiceManager.ServiceManager,
        unavailable(
          new ServiceManager.ServiceFailed({
            method: options.platform === "darwin" ? "launch-agent" : "systemd-user",
            reason: `the service settings could not be read: ${error.message}`
          })
        )
      ))
  )

export const platformChoices = (options: Service.ServiceManager.Options): Choices => ({
  alerts: Alerts.layer.pipe(Layer.provide(options.platform === "darwin" ? layerMacOS : layerLinux)),
  serviceManager: serviceManager(options),
  secretStore: SecretStores.layer(options.platform),
  wakeTarget: WakeTargets.layer()
})

const database = Layer.unwrap(
  Effect.gen(function*() {
    const paths = yield* Paths.Paths
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    yield* fs.makeDirectory(path.dirname(paths.databaseFile), { recursive: true })
    return Database.layer({ filename: paths.databaseFile })
  })
)

const officialConnectors = (options: Options) =>
  Layer.unwrap(
    Effect.map(
      Effect.orDie(Schema.decodeUnknownEffect(Schema.Array(OfficialConnectorSource.Official))(options.officialConnectors)),
      (known) => OfficialConnectors.layer({ known, releaseUrl: options.releaseUrl })
    )
  ).pipe(Layer.provideMerge(ConnectorImport.layer), Layer.provide(ConnectorImport.layerFetchHttpClient))

/** Applies a written logLevel to the live level, so a SetSettings takes effect at once. */
const settings = Layer.effect(
  SettingsStore.SettingsStore,
  Effect.gen(function*() {
    const store = yield* SettingsStore.SettingsStore
    return SettingsStore.SettingsStore.of({
      read: store.read,
      write: (value) => Effect.tap(store.write(value), () => Level.apply(value.logLevel)),
      update: (change) => Effect.tap(store.update(change), (value) => Level.apply(value.logLevel))
    })
  })
).pipe(Layer.provide(SettingsFile.layer))

const remember = (value: Redacted.Redacted<string>) => Effect.sync(() => Secrets.register([Redacted.value(value)]))

/** Every secret value read or stored is known to the logs, which hide it wherever it turns up. */
const knownSecrets = (store: Choices["secretStore"]) =>
  Layer.effect(
    SecretStore.SecretStore,
    Effect.gen(function*() {
      const secrets = yield* SecretStore.SecretStore
      return SecretStore.SecretStore.of({
        ...secrets,
        set: (connector, field, value) => Effect.andThen(remember(value), secrets.set(connector, field, value)),
        get: (connector, field) =>
          Effect.tap(secrets.get(connector, field), Option.match({ onNone: () => Effect.void, onSome: remember }))
      })
    })
  ).pipe(Layer.provide(store))

const ports = (options: Options) =>
  Layer.mergeAll(
    officialConnectors(options),
    Repositories.layer.pipe(Layer.provide(database)),
    options.alerts,
    options.serviceManager,
    options.wakeTarget,
    StdioConnectorRuntime.layer(options.runtime)
  ).pipe(
    Layer.provideMerge(Layer.mergeAll(settings, knownSecrets(options.secretStore), ConnectorDirectoryLive.layer))
  )

const halves = Layer.effectContext(
  Effect.gen(function*() {
    const slot = yield* Deferred.make<SubscriptionIntake.SubscriptionIntake["Service"]>()
    const late = SubscriptionIntake.SubscriptionIntake.of({
      ingest: (subscription, item) => Effect.flatMap(Deferred.await(slot), (intake) => intake.ingest(subscription, item)),
      connectorChanged: (connector) => Effect.flatMap(Deferred.await(slot), (intake) => intake.connectorChanged(connector)),
      connectorRemoved: (connector, since, problem) =>
        Effect.flatMap(Deferred.await(slot), (intake) => intake.connectorRemoved(connector, since, problem))
    })
    const connectors = yield* Layer.build(
      Layer.provide(layerConnectors, Layer.succeed(SubscriptionIntake.SubscriptionIntake, late))
    )
    yield* Effect.addFinalizer(() => Deferred.interrupt(slot))
    const intake = yield* Layer.build(Layer.provide(layerSubscriptionIntake, Layer.succeedContext(connectors)))
    yield* Deferred.succeed(slot, Context.get(intake, SubscriptionIntake.SubscriptionIntake))
    return Context.merge(connectors, intake)
  })
)

const loops = Layer.effectDiscard(Effect.forkScoped(runSubscriptionDaemon))

const services = (options: Options) =>
  loops.pipe(
    Layer.provideMerge(halves),
    Layer.provideMerge(Layer.mergeAll(layerSubscriptionLocks, layerSubscriptionSignals, layerRemovedConnectors)),
    Layer.provideMerge(ports(options))
  )

const lifecycle = (options: Options) =>
  Layer.effectDiscard(
    Effect.gen(function*() {
      yield* Effect.logInfo("daemon started").pipe(Effect.annotateLogs({ version: options.version ?? "unknown" }))
      yield* Effect.addFinalizer(() => Effect.logInfo("daemon stopped"))
    })
  )

/** daemon.jsonl at the live level; ERROR and above also to stderr, which the service keeps in daemon.log. */
export const logger = FileLog.layer({ src: "daemon", console: FileLog.stderrLogger("daemon", "Error") })

export const layer = (options: Options) =>
  RpcServer.layer(DaemonContract.DaemonContract, { disableFatalDefects: true }).pipe(
    Layer.provide(Handlers.layer),
    Layer.provide(services(options)),
    Layer.provide(DaemonServer.layerFromPaths),
    Layer.provideMerge(lifecycle(options)),
    Layer.provide(logger)
  )

export const run = (options: Options) => Layer.launch(layer(options))
