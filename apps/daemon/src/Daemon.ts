import {
  type AlertSink,
  layerConnectors,
  layerRemovedConnectors,
  layerSubscriptionIntake,
  layerSubscriptionLocks,
  layerSubscriptionSignals,
  OfficialConnectorSource,
  runSubscriptionDaemon,
  type SecretStore,
  ServiceManager,
  SubscriptionIntake,
  type WakeTarget
} from "@exangelos/application"
import * as Alerts from "@exangelos/alerts"
import { DaemonContract } from "@exangelos/contracts"
import { DaemonServer } from "@exangelos/daemon-client"
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
import { Context, Deferred, Effect, FileSystem, Layer, Path, Schema } from "effect"
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
  readonly wakeTarget: Layer.Layer<WakeTarget.WakeTarget, never, Platform>
}

export interface Options extends Choices {
  readonly officialConnectors: ReadonlyArray<unknown>
  readonly releaseUrl: string | undefined
  readonly runtime?: StdioConnectorRuntime.Options | undefined
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

const ports = (options: Options) =>
  Layer.mergeAll(
    officialConnectors(options),
    Repositories.layer.pipe(Layer.provide(database)),
    options.alerts,
    options.serviceManager,
    options.wakeTarget,
    StdioConnectorRuntime.layer(options.runtime)
  ).pipe(
    Layer.provideMerge(Layer.mergeAll(SettingsFile.layer, options.secretStore, ConnectorDirectoryLive.layer))
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

export const layer = (options: Options) =>
  RpcServer.layer(DaemonContract.DaemonContract, { disableFatalDefects: true }).pipe(
    Layer.provide(Handlers.layer),
    Layer.provide(services(options)),
    Layer.provide(DaemonServer.layerFromPaths)
  )

export const run = (options: Options) => Layer.launch(layer(options))
