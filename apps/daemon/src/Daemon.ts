import {
  type AlertSink,
  layerPlugins,
  layerRemovedPlugins,
  layerSubscriptionIntake,
  layerSubscriptionLocks,
  layerSubscriptionSignals,
  OfficialPluginSource,
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
import * as OfficialPlugins from "@exangelos/official-plugins"
import { Paths } from "@exangelos/paths"
import * as PluginDirectoryLive from "@exangelos/plugin-directory"
import * as PluginImport from "@exangelos/plugin-import"
import { StdioPluginRuntime } from "@exangelos/plugin-runtime"
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

/** What the daemon takes from the process it runs in. */
export type Platform = FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner | Paths.Paths

/** The ports that differ by platform. Tests pass fakes for them. */
export interface Choices {
  readonly alerts: Layer.Layer<AlertSink.AlertSink, never, Platform>
  readonly serviceManager: Layer.Layer<ServiceManager.ServiceManager, never, Platform>
  readonly secretStore: Layer.Layer<SecretStore.SecretStore, never, Platform>
  readonly wakeTarget: Layer.Layer<WakeTarget.WakeTarget, never, Platform>
}

export interface Options extends Choices {
  /** The official plugins the binary carries, as the build constant holds them. */
  readonly officialPlugins: ReadonlyArray<unknown>
  /** Where the official plugins' release files live; undefined when the build names none. */
  readonly releaseUrl: string | undefined
  readonly runtime?: StdioPluginRuntime.Options | undefined
}

const unavailable = (failure: ServiceManager.ServiceFailed) =>
  ServiceManager.ServiceManager.of({ status: Effect.fail(failure), install: Effect.fail(failure), start: Effect.fail(failure) })

/** The launchd or systemd user service. Unreadable service settings fail every call instead of the daemon. */
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

/** The real ports for this machine, from its platform, the daemon's executable and the user's uid. */
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

const officialPlugins = (options: Options) =>
  Layer.unwrap(
    Effect.map(
      Effect.orDie(Schema.decodeUnknownEffect(Schema.Array(OfficialPluginSource.Official))(options.officialPlugins)),
      (known) => OfficialPlugins.layer({ known, releaseUrl: options.releaseUrl })
    )
  ).pipe(Layer.provideMerge(PluginImport.layer), Layer.provide(PluginImport.layerFetchHttpClient))

const ports = (options: Options) =>
  Layer.mergeAll(
    officialPlugins(options),
    Repositories.layer.pipe(Layer.provide(database)),
    options.alerts,
    options.serviceManager,
    options.wakeTarget,
    StdioPluginRuntime.layer(options.runtime)
  ).pipe(
    Layer.provideMerge(Layer.mergeAll(SettingsFile.layer, options.secretStore, PluginDirectoryLive.layer))
  )

/**
 * The plugin half and the subscription intake, which need each other: the supervisor feeds the
 * intake, and the intake asks PluginAccess to describe and watch. The supervisor gets an intake
 * that waits for the real one, which is built right after the plugin half. Nothing waits in the
 * build itself, because the supervisor forks its startup.
 */
const halves = Layer.effectContext(
  Effect.gen(function*() {
    const slot = yield* Deferred.make<SubscriptionIntake.SubscriptionIntake["Service"]>()
    const late = SubscriptionIntake.SubscriptionIntake.of({
      ingest: (subscription, item) => Effect.flatMap(Deferred.await(slot), (intake) => intake.ingest(subscription, item)),
      pluginChanged: (plugin) => Effect.flatMap(Deferred.await(slot), (intake) => intake.pluginChanged(plugin)),
      pluginRemoved: (plugin, since, problem) =>
        Effect.flatMap(Deferred.await(slot), (intake) => intake.pluginRemoved(plugin, since, problem))
    })
    const plugins = yield* Layer.build(
      Layer.provide(layerPlugins, Layer.succeed(SubscriptionIntake.SubscriptionIntake, late))
    )
    // Runs before the supervisor's own finalisers, so a call still waiting on the slot when the
    // daemon stops before the intake exists ends instead of holding the teardown.
    yield* Effect.addFinalizer(() => Deferred.interrupt(slot))
    const intake = yield* Layer.build(Layer.provide(layerSubscriptionIntake, Layer.succeedContext(plugins)))
    yield* Deferred.succeed(slot, Context.get(intake, SubscriptionIntake.SubscriptionIntake))
    return Context.merge(plugins, intake)
  })
)

const loops = Layer.effectDiscard(Effect.forkScoped(runSubscriptionDaemon))

/** Every service the handlers use: the ports, both halves of the application and their loops. */
const services = (options: Options) =>
  loops.pipe(
    Layer.provideMerge(halves),
    Layer.provideMerge(Layer.mergeAll(layerSubscriptionLocks, layerSubscriptionSignals, layerRemovedPlugins)),
    Layer.provideMerge(ports(options))
  )

export const layer = (options: Options) =>
  RpcServer.layer(DaemonContract.DaemonContract, { disableFatalDefects: true }).pipe(
    Layer.provide(Handlers.layer),
    Layer.provide(services(options)),
    Layer.provide(DaemonServer.layerFromPaths)
  )

export const run = (options: Options) => Layer.launch(layer(options))
