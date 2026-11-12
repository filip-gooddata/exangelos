import { Context, DateTime, Deferred, Duration, Effect, FiberMap, Layer, Option, Redacted, Ref, Semaphore, Stream } from "effect"
import { Catalogue, Ids, Plugin, PluginRules, Settings } from "@exangelos/domain"
import { type Alert, AlertSink } from "../ports/AlertSink.ts"
import { OfficialPluginSource } from "../ports/OfficialPluginSource.ts"
import { PluginDirectory } from "../ports/PluginDirectory.ts"
import { PluginRepository, type PluginChange } from "../ports/PluginRepository.ts"
import { PluginRuntime, type Launch, type PluginProcess } from "../ports/PluginRuntime.ts"
import { SecretStore } from "../ports/SecretStore.ts"
import { SettingsStore } from "../ports/SettingsStore.ts"
import { SubscriptionRepository } from "../ports/SubscriptionRepository.ts"
import { PluginUnavailable } from "../seam/PluginAccess.ts"
import { SubscriptionIntake } from "../seam/SubscriptionIntake.ts"

/**
 * Restarts after a crash wait 1 s, doubling per consecutive failure up to 5 min. The fifth
 * consecutive failure marks the plugin failing, and it stays failing, so unavailable, until a run
 * lasts 1 min. A run that lasted 1 min also resets the count.
 */
export const restartPolicy = {
  firstDelay: Duration.seconds(1),
  maxDelay: Duration.minutes(5),
  failingAfter: 5,
  stableAfter: Duration.minutes(1)
} as const

/** How long `ready` waits for a starting plugin before calling it unavailable. */
export const startTimeout = Duration.seconds(30)

export const backoff = (failures: number): Duration.Duration =>
  Duration.min(
    Duration.times(restartPolicy.firstDelay, 2 ** Math.max(0, failures - 1)),
    restartPolicy.maxDelay
  )

/** The in-daemon plugin half: one process per enabled or dev plugin, its streams and its file watch. */
export class PluginSupervisor extends Context.Service<PluginSupervisor, {
  /** Writes the plugin record, raising the alerts and suspension effects its change implies. */
  readonly store: (plugin: Plugin.Plugin, change?: PluginChange) => Effect.Effect<void>
  /** Applies `f` to the stored record; does nothing when the plugin is unknown. */
  readonly update: (
    name: Ids.PluginName,
    f: (plugin: Plugin.Plugin) => Plugin.Plugin,
    change?: PluginChange
  ) => Effect.Effect<Option.Option<Plugin.Plugin>>
  /** Starts, restarts or stops the process and file watch to match the stored record. */
  readonly restart: (name: Ids.PluginName) => Effect.Effect<void>
  /** Stops the process and the file watch; the record stays as it is. */
  readonly stop: (name: Ids.PluginName) => Effect.Effect<void>
  /**
   * Sends the stored configuration to the running process and returns the resulting state. With no
   * process running it returns the state the stored values give.
   */
  readonly reconfigure: (name: Ids.PluginName) => Effect.Effect<Plugin.Configuration>
  /** The running process of an available plugin, waiting while it starts. */
  readonly ready: (name: Ids.PluginName) => Effect.Effect<PluginProcess, PluginUnavailable>
  readonly watch: (subscription: Ids.SubscriptionId) => Effect.Effect<void>
  readonly unwatch: (subscription: Ids.SubscriptionId) => Effect.Effect<void>
}>()("@exangelos/application/PluginSupervisor") {}

interface Written {
  readonly after: Plugin.Plugin
  readonly raised: ReadonlyArray<Alert>
  readonly lost: boolean
  readonly regained: boolean
}

type Outcome =
  | { readonly _tag: "Stopped" }
  | { readonly _tag: "Crashed"; readonly reason: string }
  | { readonly _tag: "Incompatible"; readonly reason: string }

const stopped: Outcome = { _tag: "Stopped" }

const officialChecksum = (known: ReadonlyArray<{ readonly name: Ids.PluginName; readonly digest: string }>, name: Ids.PluginName) =>
  Option.fromNullishOr(known.find((official) => official.name === name)?.digest)

/**
 * Starts every enabled and dev plugin and watches every plugin's files. Applies a change to files
 * made while the daemon was down, and keeps the one-hour suspension timers of plugins that were
 * already unavailable.
 */
export const layerPluginSupervisor: Layer.Layer<
  PluginSupervisor,
  never,
  | PluginRepository
  | SubscriptionRepository
  | PluginRuntime
  | PluginDirectory
  | OfficialPluginSource
  | SecretStore
  | SettingsStore
  | AlertSink
  | SubscriptionIntake
> = Layer.effect(PluginSupervisor, Effect.gen(function*() {
  const plugins = yield* PluginRepository
  const subscriptions = yield* SubscriptionRepository
  const runtime = yield* PluginRuntime
  const directory = yield* PluginDirectory
  const officials = yield* OfficialPluginSource
  const secrets = yield* SecretStore
  const settings = yield* SettingsStore
  const alerts = yield* AlertSink
  const intake = yield* SubscriptionIntake

  const runs = yield* FiberMap.make<Ids.PluginName>()
  const fileWatches = yield* FiberMap.make<Ids.PluginName>()
  const timers = yield* FiberMap.make<Ids.PluginName>()
  const streams = yield* FiberMap.make<Ids.SubscriptionId>()
  const processes = yield* Ref.make<ReadonlyMap<Ids.PluginName, PluginProcess>>(new Map())
  const changed = yield* Ref.make(yield* Deferred.make<void>())
  const writes = yield* Semaphore.make(1)

  const checksum = (name: Ids.PluginName) => officialChecksum(officials.known, name)
  const limits = Effect.map(Effect.orElseSucceed(settings.read, () => Settings.initial), (s) => s.limits)

  const signal = Effect.flatMap(Deferred.make<void>(), (next) =>
    Effect.flatMap(Ref.getAndSet(changed, next), (previous) => Deferred.succeed(previous, undefined)))

  const suspendAfter = (name: Ids.PluginName, since: DateTime.Utc) =>
    FiberMap.run(timers, name, Effect.gen(function*() {
      const wait = Duration.subtract(
        (yield* limits).unavailableBeforeWake,
        Duration.millis(DateTime.toEpochMillis(yield* DateTime.now) - DateTime.toEpochMillis(since))
      )
      yield* Effect.sleep(Duration.max(wait, Duration.zero))
      const current = yield* plugins.find(name)
      const problem = Option.match(current, {
        onNone: () => "it was removed",
        onSome: (plugin) => Option.getOrElse(PluginRules.problem(plugin), () => "it is unavailable")
      })
      yield* intake.suspended(name, since, problem)
    }))

  const write = (
    before: Option.Option<Plugin.Plugin>,
    next: Plugin.Plugin,
    change?: PluginChange
  ): Effect.Effect<Written> =>
    Effect.gen(function*() {
      const after = PluginRules.trackAvailability(next, yield* DateTime.now)
      yield* plugins.store(after, change)
      const was = Option.match(before, { onNone: () => false, onSome: PluginRules.isAvailable })
      const is = PluginRules.isAvailable(after)
      return { after, raised: PluginRules.alerts(before, after), lost: was && !is, regained: !was && is }
    })

  const afterWrite = (result: Written): Effect.Effect<void> =>
    Effect.gen(function*() {
      const name = result.after.name
      yield* Effect.forEach(result.raised, (alert) => Effect.ignore(alerts.show(alert)), { discard: true })
      if (result.lost) {
        yield* suspendAfter(name, result.after.unavailableSince ?? (yield* DateTime.now))
        yield* closeStreams(name)
      }
      if (result.regained) {
        yield* FiberMap.remove(timers, name)
        yield* intake.restored(name)
        yield* openStreams(name)
      }
      yield* signal
    })

  const store = (plugin: Plugin.Plugin, change?: PluginChange) =>
    Effect.flatMap(
      writes.withPermit(Effect.flatMap(plugins.find(plugin.name), (before) => write(before, plugin, change))),
      afterWrite
    )

  const update = (
    name: Ids.PluginName,
    f: (plugin: Plugin.Plugin) => Plugin.Plugin,
    change?: PluginChange
  ): Effect.Effect<Option.Option<Plugin.Plugin>> =>
    Effect.gen(function*() {
      const result = yield* writes.withPermit(Effect.flatMap(plugins.find(name), (before) =>
        Option.match(before, {
          onNone: () => Effect.succeed(Option.none<Written>()),
          onSome: (plugin) => Effect.map(write(before, f(plugin), change), Option.some)
        })))
      if (Option.isNone(result)) return Option.none<Plugin.Plugin>()
      yield* afterWrite(result.value)
      return Option.some(result.value.after)
    })

  const configurationOf = (name: Ids.PluginName, catalogue: Catalogue.Catalogue) =>
    Effect.gen(function*() {
      const values = yield* plugins.values(name)
      const secretFields = catalogue.configuration.filter((field) => field._tag === "Secret")
      const stored = yield* Effect.forEach(secretFields, (field) =>
        Effect.map(
          Effect.orElseSucceed(secrets.get(name, field.key), () => Option.none<Redacted.Redacted<string>>()),
          (value) => [field.key, value] as const
        ))
      const present = stored.flatMap(([key, value]) => Option.isSome(value) ? [[key, value.value] as const] : [])
      return {
        configuration: PluginRules.configuration(catalogue, values, present.map(([key]) => key)),
        values,
        present
      }
    })

  /** The only place a secret leaves the SecretStore: the Configure call. */
  const configureProcess = (name: Ids.PluginName, process: PluginProcess) =>
    Effect.gen(function*() {
      const { configuration, values, present } = yield* configurationOf(name, process.catalogue)
      if (configuration._tag === "Missing") {
        yield* update(name, (plugin) => ({ ...plugin, configuration }))
        return configuration
      }
      const withSecrets: Record<string, string> = { ...values }
      for (const [key, value] of present) withSecrets[key] = Redacted.value(value)
      const answer = yield* Effect.option(process.configure(withSecrets))
      const next: Plugin.Configuration = Option.match(answer, {
        onNone: () => configuration,
        onSome: (a) => a._tag === "Accepted" ? { _tag: "Set" } : { _tag: "Rejected", reason: a.reason }
      })
      yield* update(name, (plugin) => ({ ...plugin, configuration: next }))
      return next
    })

  const subscriptionsOf = (name: Ids.PluginName) => subscriptions.list({ plugin: name })

  const closeStreams = (name: Ids.PluginName): Effect.Effect<void> =>
    Effect.flatMap(subscriptionsOf(name), (all) =>
      Effect.forEach(all, (subscription) => FiberMap.remove(streams, subscription.id), { discard: true }))

  const openStreams = (name: Ids.PluginName): Effect.Effect<void> =>
    Effect.flatMap(subscriptions.list({ plugin: name, states: ["Active"] }), (active) =>
      Effect.forEach(active, (subscription) => openStream(subscription.id), { discard: true }))

  const rejectCredentials = (name: Ids.PluginName, reason: string): Effect.Effect<unknown> =>
    update(name, (plugin) => ({ ...plugin, configuration: { _tag: "Rejected", reason } }))

  /** One Watch stream from the stored cursor, reopened after a source failure. */
  const runStream = (id: Ids.SubscriptionId, name: Ids.PluginName, process: PluginProcess): Effect.Effect<void> =>
    Effect.gen(function*() {
      let failures = 0
      while (true) {
        const found = yield* subscriptions.find(id)
        if (Option.isNone(found) || found.value.state._tag !== "Active") return
        const subscription = found.value
        let stop = false
        const result = yield* process.watch({
          parameters: subscription.parameters,
          eventTypes: subscription.eventTypes ?? process.catalogue.eventTypes.map((spec) => spec.type),
          ...(subscription.cursor === undefined ? {} : { cursor: subscription.cursor })
        }).pipe(
          Stream.runForEachWhile((item) =>
            Effect.map(intake.ingest(id, item), (verdict) => {
              failures = 0
              stop = verdict === "stop"
              return !stop
            })
          ),
          Effect.result
        )
        if (stop) return
        if (result._tag === "Failure") {
          const error = result.failure
          if (error._tag === "PluginCrashed") return
          if (error._tag === "CredentialsRejected") {
            // Closing the plugin's streams interrupts this one, so it runs on its own fiber.
            yield* Effect.forkDetach(rejectCredentials(name, error.reason))
            return
          }
        }
        failures++
        yield* Effect.sleep(backoff(failures))
      }
    })

  const openStream = (id: Ids.SubscriptionId): Effect.Effect<void> =>
    Effect.gen(function*() {
      const subscription = yield* subscriptions.find(id)
      if (Option.isNone(subscription) || subscription.value.state._tag !== "Active") return
      const name = subscription.value.plugin
      const plugin = yield* plugins.find(name)
      const process = (yield* Ref.get(processes)).get(name)
      if (Option.isNone(plugin) || !PluginRules.isAvailable(plugin.value) || process === undefined) return
      yield* FiberMap.run(streams, id, runStream(id, name, process), { onlyIfMissing: true })
    })

  const launchOf = (plugin: Plugin.Plugin) =>
    Effect.gen(function*() {
      const at = plugin.origin._tag === "DevLink"
        ? Option.some(plugin.origin.path)
        : Option.map(
          Option.fromNullishOr((yield* directory.list).find((installed) => installed.name === plugin.name)),
          (installed) => installed.directory
        )
      if (Option.isNone(at)) return Option.none<Launch>()
      const installed = yield* directory.read(at.value)
      return Option.some<Launch>({
        name: plugin.name,
        directory: installed.directory,
        entry: installed.entry,
        dev: plugin.trust === "dev"
      })
    })

  /** One process lifetime: start, Handshake, Configure, streams, until it exits. */
  const attempt = (name: Ids.PluginName): Effect.Effect<Outcome> =>
    Effect.scoped(Effect.gen(function*() {
      const plugin = yield* plugins.find(name)
      if (Option.isNone(plugin) || plugin.value.trust === "inert") return stopped
      const launch = yield* Effect.orElseSucceed(launchOf(plugin.value), () => Option.none<Launch>())
      if (Option.isNone(launch)) return { _tag: "Crashed", reason: "its files cannot be read" } as Outcome
      const process = yield* runtime.start(launch.value)
      yield* Ref.update(processes, (all) => new Map(all).set(name, process))
      yield* Effect.addFinalizer(() =>
        Effect.andThen(
          Ref.update(processes, (all) => {
            const next = new Map(all)
            next.delete(name)
            return next
          }),
          closeStreams(name)
        ))
      // A failing plugin stays unavailable until it has run for `stableAfter`.
      const wasFailing = Option.exists(yield* plugins.find(name), (p) => p.process === "failing")
      yield* update(name, (p) => ({ ...p, catalogue: process.catalogue, process: wasFailing ? "failing" : "running" }))
      if (wasFailing) {
        yield* Effect.forkScoped(Effect.andThen(
          Effect.sleep(restartPolicy.stableAfter),
          update(name, (p) => ({ ...p, process: "running" }))
        ))
      }
      yield* configureProcess(name, process)
      yield* openStreams(name)
      const crash = yield* process.exited
      return { _tag: "Crashed", reason: crash.reason } as Outcome
    })).pipe(
      Effect.catchTags({
        PluginStartFailed: (error) => Effect.succeed<Outcome>({ _tag: "Crashed", reason: error.reason }),
        IncompatibleProtocol: (error) =>
          Effect.succeed<Outcome>({
            _tag: "Incompatible",
            reason: `it speaks protocol ${error.version}; this daemon supports ${error.supported.join(", ")}`
          })
      })
    )

  const supervise = (name: Ids.PluginName) =>
    Effect.gen(function*() {
      let failures = 0
      while (true) {
        const startedAt = DateTime.toEpochMillis(yield* DateTime.now)
        const outcome = yield* attempt(name)
        if (outcome._tag === "Stopped") return
        if (outcome._tag === "Incompatible") {
          yield* update(name, (plugin) => ({ ...plugin, process: "failing" }))
          return
        }
        const ran = DateTime.toEpochMillis(yield* DateTime.now) - startedAt
        failures = ran >= Duration.toMillis(restartPolicy.stableAfter) ? 1 : failures + 1
        const state = failures >= restartPolicy.failingAfter ? "failing" : "restarting"
        yield* update(name, (plugin) => ({ ...plugin, process: plugin.process === "failing" ? "failing" : state }))
        yield* Effect.sleep(backoff(failures))
      }
    })

  /** A third-party plugin returns to inert, an official one that no longer matches too, a dev one restarts. */
  const filesChanged = (name: Ids.PluginName, at: string, onlyIfDigestDiffers: boolean) =>
    Effect.gen(function*() {
      const installed = yield* Effect.option(directory.read(at))
      const plugin = yield* plugins.find(name)
      if (Option.isNone(installed) || Option.isNone(plugin)) return
      const same = installed.value.digest === plugin.value.digest
      if (same && (onlyIfDigestDiffers || plugin.value.trust !== "dev")) return
      const result = PluginRules.filesChanged(plugin.value, installed.value.digest, checksum(name))
      yield* update(name, () => ({ ...result.plugin, version: installed.value.version }))
      yield* Effect.forEach(Option.toArray(result.alert), (alert) => Effect.ignore(alerts.show(alert)), {
        discard: true
      })
      if (result.restart) yield* restartRun(name)
      else yield* stopRun(name)
    })

  const pluginPath = (plugin: Plugin.Plugin) =>
    plugin.origin._tag === "DevLink"
      ? Effect.succeed(Option.some(plugin.origin.path))
      : Effect.map(
        Effect.orElseSucceed(directory.list, () => []),
        (all) => Option.map(Option.fromNullishOr(all.find((i) => i.name === plugin.name)), (i) => i.directory)
      )

  const watchFiles = (plugin: Plugin.Plugin) =>
    Effect.gen(function*() {
      const at = yield* pluginPath(plugin)
      if (Option.isNone(at)) return
      yield* FiberMap.run(
        fileWatches,
        plugin.name,
        directory.changes(at.value).pipe(
          Stream.runForEach(() => filesChanged(plugin.name, at.value, false)),
          Effect.ignore
        )
      )
    })

  const restartRun = (name: Ids.PluginName) =>
    Effect.gen(function*() {
      yield* FiberMap.remove(runs, name)
      const plugin = yield* plugins.find(name)
      if (Option.isNone(plugin) || plugin.value.trust === "inert") {
        yield* update(name, (p) => ({ ...p, process: "stopped" }))
        return
      }
      yield* update(name, (p) => ({ ...p, process: p.process === "failing" ? "failing" : "stopped" }))
      yield* FiberMap.run(runs, name, supervise(name))
    })

  const stopRun = (name: Ids.PluginName) =>
    Effect.andThen(FiberMap.remove(runs, name), update(name, (p) => ({ ...p, process: "stopped" })))

  const restart = (name: Ids.PluginName) =>
    Effect.gen(function*() {
      const plugin = yield* plugins.find(name)
      if (Option.isNone(plugin)) return yield* stop(name)
      if (!(yield* FiberMap.has(fileWatches, name))) yield* watchFiles(plugin.value)
      yield* restartRun(name)
    })

  const stop = (name: Ids.PluginName) =>
    Effect.gen(function*() {
      yield* FiberMap.remove(fileWatches, name)
      yield* FiberMap.remove(runs, name)
      yield* update(name, (p) => ({ ...p, process: "stopped" }))
    })

  const reconfigure = (name: Ids.PluginName) =>
    Effect.gen(function*() {
      const process = (yield* Ref.get(processes)).get(name)
      if (process !== undefined) return yield* configureProcess(name, process)
      const plugin = yield* plugins.find(name)
      if (Option.isNone(plugin)) return { _tag: "Missing" } as Plugin.Configuration
      if (plugin.value.catalogue === undefined) return plugin.value.configuration
      const { configuration } = yield* configurationOf(name, plugin.value.catalogue)
      yield* update(name, (p) => ({ ...p, configuration }))
      return configuration
    })

  /** Still starting: trusted, not failing, and either without a catalogue yet or not running yet. */
  const starting = (plugin: Plugin.Plugin) =>
    plugin.trust !== "inert" &&
    plugin.process !== "failing" &&
    (plugin.catalogue === undefined ||
      (plugin.configuration._tag !== "Rejected" && plugin.process !== "running"))

  const ready = (name: Ids.PluginName) =>
    Effect.gen(function*() {
      while (true) {
        const wake = yield* Ref.get(changed)
        const plugin = yield* plugins.find(name)
        if (Option.isNone(plugin)) {
          return yield* new PluginUnavailable({ plugin: name, reason: "it is not installed" })
        }
        const running = (yield* Ref.get(processes)).get(name)
        if (PluginRules.isAvailable(plugin.value) && running !== undefined) return running
        if (!starting(plugin.value)) {
          const reason = Option.getOrElse(PluginRules.problem(plugin.value), () => "it is not running")
          return yield* new PluginUnavailable({ plugin: name, reason })
        }
        yield* Deferred.await(wake)
      }
    }).pipe(
      Effect.timeoutOption(startTimeout),
      Effect.flatMap(Option.match({
        onNone: () => Effect.fail(new PluginUnavailable({ plugin: name, reason: "it did not start in time" })),
        onSome: Effect.succeed
      }))
    )

  const startup = Effect.gen(function*() {
    for (const stored of yield* plugins.list) {
      const at = yield* pluginPath(stored)
      if (Option.isSome(at)) yield* filesChanged(stored.name, at.value, true)
      const plugin = Option.getOrElse(yield* plugins.find(stored.name), () => stored)
      if (plugin.unavailableSince !== undefined) yield* suspendAfter(plugin.name, plugin.unavailableSince)
      yield* watchFiles(plugin)
      if (plugin.trust !== "inert" && !(yield* FiberMap.has(runs, plugin.name))) yield* restartRun(plugin.name)
    }
  })
  yield* Effect.forkScoped(startup)

  return PluginSupervisor.of({
    store,
    update,
    restart,
    stop,
    reconfigure,
    ready,
    watch: openStream,
    unwatch: (subscription) => FiberMap.remove(streams, subscription)
  })
}))
