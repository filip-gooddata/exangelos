import { Context, DateTime, Deferred, Duration, Effect, FiberMap, Layer, Option, Redacted, Ref, Semaphore, Stream } from "effect"
import { Catalogue, Ids, Plugin, PluginRules, Refusal, Settings } from "@exangelos/domain"
import { AlertSink } from "../ports/AlertSink.ts"
import { PluginDirectory } from "../ports/PluginDirectory.ts"
import { PluginRepository, type PluginChange } from "../ports/PluginRepository.ts"
import { PluginRuntime, type Launch, type PluginProcess } from "../ports/PluginRuntime.ts"
import { SecretStore } from "../ports/SecretStore.ts"
import { SettingsStore } from "../ports/SettingsStore.ts"
import { SubscriptionRepository } from "../ports/SubscriptionRepository.ts"
import { SubscriptionIntake } from "../seam/SubscriptionIntake.ts"
import { redact } from "./redact.ts"

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
  /**
   * Applies `f` to the stored record under the write permit. Nothing is written, and none returned,
   * when the plugin is unknown or `f` returns undefined.
   */
  readonly update: (
    name: Ids.PluginName,
    f: (plugin: Plugin.Plugin) => Plugin.Plugin | undefined,
    change?: PluginChange
  ) => Effect.Effect<Option.Option<Plugin.Plugin>>
  /** Starts, restarts or stops the process and file watch to match the stored record. */
  readonly restart: (name: Ids.PluginName) => Effect.Effect<void>
  /** Stops the process and the file watch; the record stays as it is. */
  readonly stop: (name: Ids.PluginName) => Effect.Effect<void>
  /**
   * Stops the plugin, removes its record with the change, and tells the subscription half, now and
   * again once the plugin has been gone for `limits.unavailableBeforeWake`. The change's detail
   * keeps when the plugin became unavailable, so a daemon restart can set that timer again.
   */
  readonly remove: (name: Ids.PluginName, change: PluginChange, problem: string) => Effect.Effect<void>
  /**
   * Sends the stored configuration to the running process and returns the resulting state. With no
   * process running it returns the state the stored values give.
   */
  readonly reconfigure: (name: Ids.PluginName) => Effect.Effect<Plugin.Configuration>
  /** The running process of an available plugin, waiting while it starts. */
  readonly ready: (name: Ids.PluginName) => Effect.Effect<PluginProcess, Refusal.PluginUnavailable>
  readonly watch: (subscription: Ids.SubscriptionId) => Effect.Effect<void>
  readonly unwatch: (subscription: Ids.SubscriptionId) => Effect.Effect<void>
  readonly rewatch: (subscription: Ids.SubscriptionId) => Effect.Effect<void>
  /**
   * Rewatches, on the supervisor's own fiber and one pass at a time, every Watch stream opened with
   * a wake window other than the stored one.
   */
  readonly settingsChanged: Effect.Effect<void>
}>()("@exangelos/application/PluginSupervisor") {}

type Outcome =
  | { readonly _tag: "Stopped" }
  | { readonly _tag: "Crashed"; readonly reason: string }
  | { readonly _tag: "Incompatible"; readonly reason: string }

const stopped: Outcome = { _tag: "Stopped" }

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
  | SecretStore
  | SettingsStore
  | AlertSink
  | SubscriptionIntake
> = Layer.effect(PluginSupervisor, Effect.gen(function*() {
  const plugins = yield* PluginRepository
  const subscriptions = yield* SubscriptionRepository
  const runtime = yield* PluginRuntime
  const directory = yield* PluginDirectory
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
  const refreshes = yield* Semaphore.make(1)
  const scope = yield* Effect.scope
  const openedWith = yield* Ref.make<ReadonlyMap<Ids.SubscriptionId, Duration.Duration>>(new Map())
  const recordWakeWindow = (id: Ids.SubscriptionId, wakeWindow: Duration.Duration | undefined) =>
    Ref.update(openedWith, (all) => {
      const next = new Map(all)
      if (wakeWindow === undefined) next.delete(id)
      else next.set(id, wakeWindow)
      return next
    })

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
      if (Option.isSome(current)) yield* intake.pluginChanged(current.value)
    }))

  /**
   * Stores the record and applies what its availability change implies, all under one permit so
   * that a loss and a recovery never apply out of order. An unavailability episode starts when the
   * record first carries `unavailableSince`, including a new record, and ends when it drops it.
   */
  const write = (
    before: Option.Option<Plugin.Plugin>,
    next: Plugin.Plugin,
    change?: PluginChange
  ): Effect.Effect<Plugin.Plugin> =>
    Effect.gen(function*() {
      const after = PluginRules.trackAvailability(next, yield* DateTime.now)
      yield* plugins.store(after, change)
      const wasOut = Option.match(before, { onNone: () => true, onSome: (p) => p.unavailableSince !== undefined })
      const wasNew = Option.isNone(before)
      yield* Effect.forEach(PluginRules.alerts(before, after), (alert) => Effect.ignore(alerts.show(alert)), {
        discard: true
      })
      if (after.unavailableSince !== undefined && (wasNew || !wasOut)) {
        yield* suspendAfter(after.name, after.unavailableSince)
        yield* closeStreams(after.name)
        yield* intake.pluginChanged(after)
      }
      if (after.unavailableSince === undefined && wasOut) {
        yield* FiberMap.remove(timers, after.name)
        yield* intake.pluginChanged(after)
        yield* openStreams(after.name)
      }
      yield* signal
      return after
    })

  const store = (plugin: Plugin.Plugin, change?: PluginChange) =>
    writes.withPermit(Effect.asVoid(Effect.flatMap(plugins.find(plugin.name), (before) => write(before, plugin, change))))

  const updateUnlocked = (
    name: Ids.PluginName,
    f: (plugin: Plugin.Plugin) => Plugin.Plugin | undefined,
    change?: PluginChange
  ): Effect.Effect<Option.Option<Plugin.Plugin>> =>
    Effect.flatMap(plugins.find(name), (before) => {
      const next = Option.isSome(before) ? f(before.value) : undefined
      return next === undefined ? Effect.succeedNone : Effect.asSome(write(before, next, change))
    })

  const update = (
    name: Ids.PluginName,
    f: (plugin: Plugin.Plugin) => Plugin.Plugin | undefined,
    change?: PluginChange
  ): Effect.Effect<Option.Option<Plugin.Plugin>> => writes.withPermit(updateUnlocked(name, f, change))

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

  /** Replaces every stored secret value in text a plugin wrote, such as a rejection reason. */
  const scrub = (text: string, present: ReadonlyArray<readonly [string, Redacted.Redacted<string>]>) =>
    redact(text, present.map(([, value]) => Redacted.value(value)))

  /** Counts Configure calls per plugin, so a stream's late rejection cannot undo a newer configuration. */
  const generations = yield* Ref.make<ReadonlyMap<Ids.PluginName, number>>(new Map())
  const generation = (name: Ids.PluginName) => Effect.map(Ref.get(generations), (all) => all.get(name) ?? 0)

  /** The only place a secret leaves the SecretStore: the Configure call. */
  const configureProcess = (name: Ids.PluginName, process: PluginProcess) =>
    Effect.gen(function*() {
      yield* Ref.update(generations, (all) => new Map(all).set(name, (all.get(name) ?? 0) + 1))
      const { configuration, values, present } = yield* configurationOf(name, process.catalogue)
      if (configuration._tag === "Missing") {
        yield* update(name, (plugin) => ({ ...plugin, configuration }))
        return configuration
      }
      const withSecrets: Record<string, string> = { ...values }
      for (const [key, value] of present) withSecrets[key] = Redacted.value(value)
      const answer = yield* process.configure(withSecrets)
      const next: Plugin.Configuration = answer._tag === "Accepted"
        ? { _tag: "Set" }
        : { _tag: "Rejected", reason: scrub(answer.reason, present) }
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

  /** Applies a stream's rejection only while its process and configuration are still current. */
  const rejectCredentials = (name: Ids.PluginName, process: PluginProcess, configured: number, reason: string) =>
    writes.withPermit(Effect.gen(function*() {
      const current = (yield* Ref.get(processes)).get(name) === process && (yield* generation(name)) === configured
      if (!current) return
      const { present } = yield* configurationOf(name, process.catalogue)
      yield* updateUnlocked(name, (plugin) => ({
        ...plugin,
        configuration: { _tag: "Rejected", reason: scrub(reason, present) }
      }))
    }))

  /** One Watch stream from the stored cursor, reopened after a source failure. */
  const runStream = (id: Ids.SubscriptionId, name: Ids.PluginName, process: PluginProcess): Effect.Effect<void> =>
    Effect.gen(function*() {
      const configured = yield* generation(name)
      let failures = 0
      while (true) {
        const found = yield* subscriptions.find(id)
        if (Option.isNone(found) || found.value.state._tag !== "Active") return
        const subscription = found.value
        let stop = false
        const { wakeWindow } = yield* limits
        yield* recordWakeWindow(id, wakeWindow)
        const result = yield* process.watch({
          parameters: subscription.parameters,
          eventTypes: subscription.eventTypes ?? process.catalogue.eventTypes.map((spec) => spec.type),
          ...(subscription.cursor === undefined ? {} : { cursor: subscription.cursor }),
          wakeWindow
        }).pipe(
          Stream.runForEachWhile((item) =>
            // Interrupting the stream waits until an item is fully ingested.
            Effect.map(Effect.uninterruptible(intake.ingest(id, item)), (verdict) => {
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
            yield* Effect.forkDetach(rejectCredentials(name, process, configured, error.reason))
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
      yield* FiberMap.run(streams, id, Effect.ensuring(runStream(id, name, process), recordWakeWindow(id, undefined)), {
        onlyIfMissing: true
      })
    })

  const launchOf = (plugin: Plugin.Plugin) =>
    Effect.gen(function*() {
      const at = plugin.origin._tag === "DevLink"
        ? Option.some(plugin.origin.path)
        : Option.map(
          Option.fromNullishOr((yield* directory.list).find((installed) => installed.name === plugin.name)),
          (installed) => installed.directory
        )
      if (Option.isNone(at)) return Option.none<{ readonly launch: Launch; readonly digest: string }>()
      const installed = yield* directory.read(at.value)
      const launch: Launch = {
        name: plugin.name,
        directory: installed.directory,
        entry: installed.entry,
        dev: plugin.trust === "dev"
      }
      return Option.some({ launch, digest: installed.digest })
    })

  /** One process lifetime: start, Handshake, Configure, streams, until it exits. */
  const attempt = (name: Ids.PluginName): Effect.Effect<Outcome> =>
    Effect.scoped(Effect.gen(function*() {
      const plugin = yield* plugins.find(name)
      if (Option.isNone(plugin) || plugin.value.trust === "inert") return stopped
      const found = yield* Effect.orElseSucceed(launchOf(plugin.value), () => Option.none())
      if (Option.isNone(found)) return { _tag: "Crashed", reason: "its files cannot be read" } as Outcome
      const { launch, digest } = found.value
      if (plugin.value.trust !== "dev" && digest !== plugin.value.digest) {
        // The files changed after they were trusted; the file watch rules apply, on their own fiber.
        yield* Effect.forkDetach(filesChanged(name, launch.directory, true))
        return stopped
      }
      const process = yield* runtime.start(launch)
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
      yield* update(name, (p) => ({ ...p, catalogue: process.catalogue }))
      const configured = yield* Effect.result(configureProcess(name, process))
      if (configured._tag === "Failure") return { _tag: "Crashed", reason: configured.failure.reason } as Outcome
      // Available only once configured. A failing plugin stays unavailable until it has run for `stableAfter`.
      const wasFailing = Option.exists(yield* plugins.find(name), (p) => p.process === "failing")
      yield* update(name, (p) => ({ ...p, process: wasFailing ? "failing" : "running" }))
      if (wasFailing) {
        yield* Effect.forkScoped(Effect.andThen(
          Effect.sleep(restartPolicy.stableAfter),
          update(name, (p) => ({ ...p, process: "running" }))
        ))
      }
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
      if (Option.isNone(plugin)) return
      if (Option.isSome(installed)) {
        const same = installed.value.digest === plugin.value.digest
        if (same && (onlyIfDigestDiffers || plugin.value.trust !== "dev")) return
      } else if (plugin.value.trust === "inert") {
        return
      }
      // Files that can no longer be read count as changed; the digest stays the last one read.
      const digest = Option.match(installed, { onNone: () => plugin.value.digest, onSome: (i) => i.digest })
      const version = Option.match(installed, { onNone: () => plugin.value.version, onSome: (i) => i.version })
      const result = PluginRules.filesChanged(plugin.value, digest)
      yield* update(name, () => ({ ...result.plugin, version }))
      yield* Effect.forEach(Option.toArray(result.alert), (alert) => Effect.ignore(alerts.show(alert)), {
        discard: true
      })
      if (result.restart) yield* restartRun(name)
      else yield* stopRun(name)
    })

  const pluginPath = (plugin: Plugin.Plugin) =>
    plugin.origin._tag === "DevLink"
      ? Effect.succeedSome(plugin.origin.path)
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
      // A crash during Configure restarts the process, which configures it again.
      if (process !== undefined) {
        const answer = yield* Effect.option(configureProcess(name, process))
        if (Option.isSome(answer)) {
          // Open streams belong to the previous configuration; reopen them under the new one.
          if (answer.value._tag === "Set") yield* Effect.andThen(closeStreams(name), openStreams(name))
          return answer.value
        }
      }
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
          return yield* new Refusal.PluginUnavailable({ plugin: name, problem: "it is not installed" })
        }
        const running = (yield* Ref.get(processes)).get(name)
        if (PluginRules.isAvailable(plugin.value) && running !== undefined) return running
        if (!starting(plugin.value)) {
          const reason = Option.getOrElse(PluginRules.problem(plugin.value), () => "it is not running")
          return yield* new Refusal.PluginUnavailable({ plugin: name, problem: reason })
        }
        yield* Deferred.await(wake)
      }
    }).pipe(
      Effect.timeoutOption(startTimeout),
      Effect.flatMap(Option.match({
        onNone: () => Effect.fail(new Refusal.PluginUnavailable({ plugin: name, problem: "it did not start in time" })),
        onSome: Effect.succeed
      }))
    )

  const removedPrefix = "unavailable since "

  const reportRemovedAfter = (name: Ids.PluginName, since: DateTime.Utc, problem: string) =>
    FiberMap.run(timers, name, Effect.gen(function*() {
      const elapsed = DateTime.toEpochMillis(yield* DateTime.now) - DateTime.toEpochMillis(since)
      yield* Effect.sleep(Duration.max(Duration.subtract((yield* limits).unavailableBeforeWake, Duration.millis(elapsed)), Duration.zero))
      if (Option.isNone(yield* plugins.find(name))) yield* intake.pluginRemoved(name, since, problem)
    }))

  const remove = (name: Ids.PluginName, change: PluginChange, problem: string) =>
    Effect.gen(function*() {
      yield* stop(name)
      yield* writes.withPermit(Effect.gen(function*() {
        const before = yield* plugins.find(name)
        const since = Option.match(before, {
          onNone: () => change.at,
          onSome: (plugin) => plugin.unavailableSince ?? change.at
        })
        yield* plugins.remove(name, { ...change, detail: `${removedPrefix}${DateTime.formatIso(since)}; ${problem}` })
        yield* FiberMap.remove(timers, name)
        yield* closeStreams(name)
        yield* intake.pluginRemoved(name, since, problem)
        yield* reportRemovedAfter(name, since, problem)
        yield* signal
      }))
    })

  /** After a restart: the removal timer for each removed plugin that still has subscriptions. */
  const rearmRemoved = Effect.gen(function*() {
    const names = new Set((yield* subscriptions.list({ states: ["Active"] })).map((subscription) => subscription.plugin))
    for (const name of names) {
      if (Option.isSome(yield* plugins.find(name))) continue
      const last = (yield* plugins.changes(name)).filter((c) => c.kind === "remove" || c.kind === "dev-unlink").at(-1)
      const detail = last?.detail
      if (detail === undefined || !detail.startsWith(removedPrefix)) continue
      const [iso, ...rest] = detail.slice(removedPrefix.length).split("; ")
      const since = DateTime.make(iso!)
      if (Option.isSome(since)) yield* reportRemovedAfter(name, DateTime.toUtc(since.value), rest.join("; "))
    }
  })

  const startup = Effect.gen(function*() {
    yield* rearmRemoved
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

  const rewatch = (subscription: Ids.SubscriptionId) =>
    Effect.andThen(FiberMap.remove(streams, subscription), openStream(subscription))

  const refresh = Effect.gen(function*() {
    const { wakeWindow } = yield* limits
    const opened = yield* Ref.get(openedWith)
    const stale = Array.from(streams, ([id]) => id).filter((id) => {
      const used = opened.get(id)
      return used !== undefined && !Duration.equals(used, wakeWindow)
    })
    yield* Effect.forEach(stale, rewatch, { discard: true })
  })

  return PluginSupervisor.of({
    store,
    update,
    restart,
    stop,
    remove,
    reconfigure,
    ready,
    watch: openStream,
    // The intake may unwatch from inside the stream's own ingest, so the removal runs on its own fiber.
    unwatch: (subscription) => Effect.asVoid(Effect.forkDetach(FiberMap.remove(streams, subscription))),
    rewatch,
    settingsChanged: Effect.asVoid(Effect.forkIn(refreshes.withPermit(refresh), scope))
  })
}))
