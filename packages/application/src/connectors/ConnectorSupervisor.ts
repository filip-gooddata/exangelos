import { Cause, Context, DateTime, Deferred, Duration, Effect, FiberMap, Layer, Option, Redacted, Ref, Semaphore, Stream } from "effect"
import { Catalogue, Ids, Connector, ConnectorRules, Refusal, Settings } from "@exangelos/domain"
import { AlertSink } from "../ports/AlertSink.ts"
import { ConnectorDirectory } from "../ports/ConnectorDirectory.ts"
import { ConnectorRepository, type ConnectorChange } from "../ports/ConnectorRepository.ts"
import { ConnectorRuntime, type Launch, type ConnectorProcess } from "../ports/ConnectorRuntime.ts"
import { SecretStore } from "../ports/SecretStore.ts"
import { SettingsStore } from "../ports/SettingsStore.ts"
import { SubscriptionRepository } from "../ports/SubscriptionRepository.ts"
import { SubscriptionIntake } from "../seam/SubscriptionIntake.ts"
import { redact } from "./redact.ts"

/**
 * Restarts after a crash wait 1 s, doubling per consecutive failure up to 5 min. The fifth
 * consecutive failure marks the connector failing, and it stays failing, so unavailable, until a run
 * lasts 1 min. A run that lasted 1 min also resets the count.
 */
export const restartPolicy = {
  firstDelay: Duration.seconds(1),
  maxDelay: Duration.minutes(5),
  failingAfter: 5,
  stableAfter: Duration.minutes(1)
} as const

/** How long `ready` waits for a starting connector before calling it unavailable. */
export const startTimeout = Duration.seconds(30)

/** How long a started connector may take to serve its logo. */
export const iconTimeout = Duration.seconds(10)

export const backoff = (failures: number): Duration.Duration =>
  Duration.min(
    Duration.times(restartPolicy.firstDelay, 2 ** Math.max(0, failures - 1)),
    restartPolicy.maxDelay
  )

/** The in-daemon connector half: one process per enabled or dev connector, its streams and its file watch. */
export class ConnectorSupervisor extends Context.Service<ConnectorSupervisor, {
  /** Writes the connector record, raising the alerts and suspension effects its change implies. */
  readonly store: (connector: Connector.Connector, change?: ConnectorChange) => Effect.Effect<void>
  /**
   * Applies `f` to the stored record under the write permit. Nothing is written, and none returned,
   * when the connector is unknown or `f` returns undefined.
   */
  readonly update: (
    name: Ids.ConnectorName,
    f: (connector: Connector.Connector) => Connector.Connector | undefined,
    change?: ConnectorChange
  ) => Effect.Effect<Option.Option<Connector.Connector>>
  /** Starts, restarts or stops the process and file watch to match the stored record. */
  readonly restart: (name: Ids.ConnectorName) => Effect.Effect<void>
  /** Stops the process and the file watch; the record stays as it is. */
  readonly stop: (name: Ids.ConnectorName) => Effect.Effect<void>
  /**
   * Stops the connector, removes its record with the change, and tells the subscription half, now and
   * again once the connector has been gone for `limits.unavailableBeforeWake`. The change's detail
   * keeps when the connector became unavailable, so a daemon restart can set that timer again.
   */
  readonly remove: (name: Ids.ConnectorName, change: ConnectorChange, problem: string) => Effect.Effect<void>
  /**
   * Sends the stored configuration to the running process and returns the resulting state. With no
   * process running it returns the state the stored values give.
   */
  readonly reconfigure: (name: Ids.ConnectorName) => Effect.Effect<Connector.Configuration>
  /** The running process of an available connector, waiting while it starts. */
  readonly ready: (name: Ids.ConnectorName) => Effect.Effect<ConnectorProcess, Refusal.ConnectorUnavailable>
  /** The connector's status with the logo its latest process served, kept while it is down. */
  readonly status: (connector: Connector.Connector) => Connector.Status
  readonly watch: (subscription: Ids.SubscriptionId) => Effect.Effect<void>
  readonly unwatch: (subscription: Ids.SubscriptionId) => Effect.Effect<void>
  readonly rewatch: (subscription: Ids.SubscriptionId) => Effect.Effect<void>
  /**
   * Rewatches, on the supervisor's own fiber and one pass at a time, every Watch stream not yet
   * known to be open with the stored wake window.
   */
  readonly settingsChanged: Effect.Effect<void>
  /**
   * Runs `effect` while no other change to the connector's files or trust runs: official fetch or
   * refresh, enable, disable, removal or dev unlink of that name, or any import or dev link.
   */
  readonly exclusiveFor: <A, E, R>(name: Ids.ConnectorName, effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
  /** Runs `effect`, an import or dev link whose name is known only once placed, exclusively of every name. */
  readonly exclusive: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
  /** Waits until the startup pass has checked, watched and started every stored connector. */
  readonly started: Effect.Effect<void>
}>()("@exangelos/application/ConnectorSupervisor") {}

type Outcome =
  | { readonly _tag: "Stopped" }
  | { readonly _tag: "Crashed"; readonly reason: string }
  | { readonly _tag: "Incompatible"; readonly reason: string }

const stopped: Outcome = { _tag: "Stopped" }

/**
 * Starts every enabled and dev connector and watches every connector's files. Applies a change to files
 * made while the daemon was down, and keeps the one-hour suspension timers of connectors that were
 * already unavailable.
 */
export const layerConnectorSupervisor: Layer.Layer<
  ConnectorSupervisor,
  never,
  | ConnectorRepository
  | SubscriptionRepository
  | ConnectorRuntime
  | ConnectorDirectory
  | SecretStore
  | SettingsStore
  | AlertSink
  | SubscriptionIntake
> = Layer.effect(ConnectorSupervisor, Effect.gen(function*() {
  const connectors = yield* ConnectorRepository
  const subscriptions = yield* SubscriptionRepository
  const runtime = yield* ConnectorRuntime
  const directory = yield* ConnectorDirectory
  const secrets = yield* SecretStore
  const settings = yield* SettingsStore
  const alerts = yield* AlertSink
  const intake = yield* SubscriptionIntake

  const runs = yield* FiberMap.make<Ids.ConnectorName>()
  const fileWatches = yield* FiberMap.make<Ids.ConnectorName>()
  const timers = yield* FiberMap.make<Ids.ConnectorName>()
  const streams = yield* FiberMap.make<Ids.SubscriptionId>()
  const processes = yield* Ref.make<ReadonlyMap<Ids.ConnectorName, ConnectorProcess>>(new Map())
  const changed = yield* Ref.make(yield* Deferred.make<void>())
  const writes = yield* Semaphore.make(1)
  const refreshes = yield* Semaphore.make(1)
  const scope = yield* Effect.scope
  const observationFailures = new Map<Ids.SubscriptionId, { name: Ids.ConnectorName; category: Connector.ObservationCategory }>()
  /** The logo each connector's latest process served. A new process replaces it; a removal drops it. */
  const icons = new Map<Ids.ConnectorName, Connector.Icon>()
  const status = (connector: Connector.Connector): Connector.Status => {
    const icon = icons.get(connector.name)
    const shown: Connector.Status = icon === undefined ? connector : { ...connector, icon }
    const failures = Array.from(observationFailures.values()).filter((failure) => failure.name === connector.name)
    if (failures.length === 0) return shown
    return {
      ...shown,
      observation: { affectedWatches: failures.length, categories: [...new Set(failures.map((f) => f.category))].sort() }
    }
  }
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

  const suspendAfter = (name: Ids.ConnectorName, since: DateTime.Utc) =>
    FiberMap.run(timers, name, Effect.gen(function*() {
      const wait = Duration.subtract(
        (yield* limits).unavailableBeforeWake,
        Duration.millis(DateTime.toEpochMillis(yield* DateTime.now) - DateTime.toEpochMillis(since))
      )
      yield* Effect.sleep(Duration.max(wait, Duration.zero))
      const current = yield* connectors.find(name)
      if (Option.isSome(current)) yield* intake.connectorChanged(current.value)
    }))

  /**
   * Stores the record and applies what its availability change implies, all under one permit so
   * that a loss and a recovery never apply out of order. An unavailability episode starts when the
   * record first carries `unavailableSince`, including a new record, and ends when it drops it.
   */
  const write = (
    before: Option.Option<Connector.Connector>,
    next: Connector.Connector,
    change?: ConnectorChange
  ): Effect.Effect<Connector.Connector> =>
    Effect.gen(function*() {
      const after = ConnectorRules.trackAvailability(next, yield* DateTime.now)
      yield* connectors.store(after, change)
      const wasOut = Option.match(before, { onNone: () => true, onSome: (p) => p.unavailableSince !== undefined })
      const wasNew = Option.isNone(before)
      yield* Effect.forEach(ConnectorRules.alerts(before, after), (alert) => Effect.ignore(alerts.show(alert)), {
        discard: true
      })
      if (after.unavailableSince !== undefined && (wasNew || !wasOut)) {
        yield* suspendAfter(after.name, after.unavailableSince)
        yield* closeStreams(after.name)
        yield* intake.connectorChanged(after)
      }
      if (after.unavailableSince === undefined && wasOut) {
        yield* FiberMap.remove(timers, after.name)
        yield* intake.connectorChanged(after)
        yield* openStreams(after.name)
      }
      yield* signal
      return after
    })

  const store = (connector: Connector.Connector, change?: ConnectorChange) =>
    writes.withPermit(Effect.asVoid(Effect.flatMap(connectors.find(connector.name), (before) => write(before, connector, change))))

  const updateUnlocked = (
    name: Ids.ConnectorName,
    f: (connector: Connector.Connector) => Connector.Connector | undefined,
    change?: ConnectorChange
  ): Effect.Effect<Option.Option<Connector.Connector>> =>
    Effect.flatMap(connectors.find(name), (before) => {
      const next = Option.isSome(before) ? f(before.value) : undefined
      return next === undefined ? Effect.succeedNone : Effect.asSome(write(before, next, change))
    })

  const update = (
    name: Ids.ConnectorName,
    f: (connector: Connector.Connector) => Connector.Connector | undefined,
    change?: ConnectorChange
  ): Effect.Effect<Option.Option<Connector.Connector>> => writes.withPermit(updateUnlocked(name, f, change))

  const configurationOf = (name: Ids.ConnectorName, catalogue: Catalogue.Catalogue) =>
    Effect.gen(function*() {
      const values = yield* connectors.values(name)
      const secretFields = catalogue.configuration.filter((field) => field._tag === "Secret")
      const stored = yield* Effect.forEach(secretFields, (field) =>
        Effect.map(
          Effect.orElseSucceed(secrets.get(name, field.key), () => Option.none<Redacted.Redacted<string>>()),
          (value) => [field.key, value] as const
        ))
      const present = stored.flatMap(([key, value]) => Option.isSome(value) ? [[key, value.value] as const] : [])
      return {
        configuration: ConnectorRules.configuration(catalogue, values, present.map(([key]) => key)),
        values,
        present
      }
    })

  /** Replaces every stored secret value in text a connector wrote, such as a rejection reason. */
  const scrub = (text: string, present: ReadonlyArray<readonly [string, Redacted.Redacted<string>]>) =>
    redact(text, present.map(([, value]) => Redacted.value(value)))

  /** Counts Configure calls per connector, so a stream's late rejection cannot undo a newer configuration. */
  const generations = yield* Ref.make<ReadonlyMap<Ids.ConnectorName, number>>(new Map())
  const generation = (name: Ids.ConnectorName) => Effect.map(Ref.get(generations), (all) => all.get(name) ?? 0)

  /** The only place a secret leaves the SecretStore: the Configure call. */
  const configureProcess = (name: Ids.ConnectorName, process: ConnectorProcess) =>
    Effect.gen(function*() {
      yield* Ref.update(generations, (all) => new Map(all).set(name, (all.get(name) ?? 0) + 1))
      const { configuration, values, present } = yield* configurationOf(name, process.catalogue)
      if (configuration._tag === "Missing") {
        yield* update(name, (connector) => ({ ...connector, configuration }))
        return configuration
      }
      const withSecrets: Record<string, string> = { ...values }
      for (const [key, value] of present) withSecrets[key] = Redacted.value(value)
      const answer = yield* process.configure(withSecrets)
      const next: Connector.Configuration = answer._tag === "Accepted"
        ? { _tag: "Set" }
        : { _tag: "Rejected", reason: scrub(answer.reason, present) }
      yield* update(name, (connector) => ({ ...connector, configuration: next }))
      return next
    })

  const subscriptionsOf = (name: Ids.ConnectorName) => subscriptions.list({ connector: name })

  const closeStreams = (name: Ids.ConnectorName): Effect.Effect<void> =>
    Effect.flatMap(subscriptionsOf(name), (all) =>
      Effect.forEach(all, (subscription) => FiberMap.remove(streams, subscription.id), { discard: true }))

  const openStreams = (name: Ids.ConnectorName): Effect.Effect<void> =>
    Effect.flatMap(subscriptions.list({ connector: name, states: ["Active"] }), (active) =>
      Effect.forEach(active, (subscription) => openStream(subscription.id), { discard: true }))

  /** Applies a stream's rejection only while its process and configuration are still current. */
  const rejectCredentials = (name: Ids.ConnectorName, process: ConnectorProcess, configured: number, reason: string) =>
    writes.withPermit(Effect.gen(function*() {
      const current = (yield* Ref.get(processes)).get(name) === process && (yield* generation(name)) === configured
      if (!current) return
      const { present } = yield* configurationOf(name, process.catalogue)
      yield* updateUnlocked(name, (connector) => ({
        ...connector,
        configuration: { _tag: "Rejected", reason: scrub(reason, present) }
      }))
    }))

  /** One Watch stream from the stored cursor, reopened after a source failure. */
  const runStream = (id: Ids.SubscriptionId, name: Ids.ConnectorName, process: ConnectorProcess): Effect.Effect<void> =>
    Effect.gen(function*() {
      const configured = yield* generation(name)
      let failures = 0
      while (true) {
        const found = yield* subscriptions.find(id)
        if (Option.isNone(found) || found.value.state._tag !== "Active") return
        const subscription = found.value
        let stop = false
        // A settings refresh during the read sees no recorded wake window and rewatches the stream.
        yield* recordWakeWindow(id, undefined)
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
              observationFailures.delete(id)
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
          if (error._tag === "ConnectorCrashed") return
          if (error._tag === "CredentialsRejected") {
            // Closing the connector's streams interrupts this one, so it runs on its own fiber.
            yield* Effect.forkDetach(rejectCredentials(name, process, configured, error.reason))
            return
          }
          const category = error.category ?? "unavailable"
          if (observationFailures.get(id)?.category !== category) {
            observationFailures.set(id, { name, category })
            yield* Effect.logWarning("watch observation failed").pipe(
              Effect.annotateLogs({ connector: name, subscription: id, category })
            )
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
      const name = subscription.value.connector
      const connector = yield* connectors.find(name)
      const process = (yield* Ref.get(processes)).get(name)
      if (Option.isNone(connector) || !ConnectorRules.isAvailable(connector.value) || process === undefined) return
      yield* FiberMap.run(streams, id, Effect.ensuring(runStream(id, name, process), Effect.suspend(() => {
        observationFailures.delete(id)
        return recordWakeWindow(id, undefined)
      })), {
        onlyIfMissing: true
      })
    })

  const launchOf = (connector: Connector.Connector) =>
    Effect.gen(function*() {
      const at = connector.origin._tag === "DevLink"
        ? Option.some(connector.origin.path)
        : Option.map(
          Option.fromNullishOr((yield* directory.list).find((installed) => installed.name === connector.name)),
          (installed) => installed.directory
        )
      if (Option.isNone(at)) return Option.none<{ readonly launch: Launch; readonly digest: string }>()
      const installed = yield* directory.read(at.value)
      const launch: Launch = {
        name: connector.name,
        directory: installed.directory,
        entry: installed.entry,
        dev: connector.trust === "dev"
      }
      return Option.some({ launch, digest: installed.digest })
    })

  /**
   * Asks a started process for its logo and keeps it. Serving none, or one the checks refuse, drops the
   * kept logo; a process that fails to answer leaves it.
   */
  const fetchIcon = (name: Ids.ConnectorName, process: ConnectorProcess) =>
    process.icon.pipe(
      Effect.timeout(iconTimeout),
      Effect.flatMap((served) =>
        Effect.andThen(
          Effect.sync(() => Option.isSome(served) ? icons.set(name, served.value) : icons.delete(name)),
          signal
        )
      ),
      Effect.catch((error) => Effect.logWarning(`Connector ${name} did not serve its icon; keeping the last one`, Cause.fail(error)))
    )

  /** One process lifetime: start, Handshake, Icon, Configure, streams, until it exits. */
  const attempt = (name: Ids.ConnectorName): Effect.Effect<Outcome> =>
    Effect.scoped(Effect.gen(function*() {
      const connector = yield* connectors.find(name)
      if (Option.isNone(connector) || connector.value.trust === "inert") return stopped
      const found = yield* Effect.orElseSucceed(launchOf(connector.value), () => Option.none())
      if (Option.isNone(found)) return { _tag: "Crashed", reason: "its files cannot be read" } as Outcome
      const { launch, digest } = found.value
      if (connector.value.trust !== "dev" && digest !== connector.value.digest) {
        // The files changed after they were trusted; the file watch rules apply, on their own fiber.
        yield* Effect.logWarning("connector files changed since trusted")
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
      yield* Effect.forkScoped(fetchIcon(name, process))
      const configured = yield* Effect.result(configureProcess(name, process))
      if (configured._tag === "Failure") return { _tag: "Crashed", reason: configured.failure.reason } as Outcome
      // Available only once configured. A failing connector stays unavailable until it has run for `stableAfter`.
      const wasFailing = Option.exists(yield* connectors.find(name), (p) => p.process === "failing")
      yield* update(name, (p) => ({ ...p, process: wasFailing ? "failing" : "running" }))
      yield* Effect.logInfo("connector started").pipe(Effect.annotateLogs({ state: wasFailing ? "failing" : "running" }))
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
        ConnectorStartFailed: (error) => Effect.succeed<Outcome>({ _tag: "Crashed", reason: error.reason }),
        IncompatibleProtocol: (error) =>
          Effect.succeed<Outcome>({
            _tag: "Incompatible",
            reason: `it speaks protocol ${error.version}; this daemon supports ${error.supported.join(", ")}`
          })
      })
    )

  const supervise = (name: Ids.ConnectorName) =>
    Effect.gen(function*() {
      let failures = 0
      while (true) {
        const startedAt = DateTime.toEpochMillis(yield* DateTime.now)
        const outcome = yield* attempt(name)
        if (outcome._tag === "Stopped") {
          yield* Effect.logInfo("connector stopped")
          return
        }
        if (outcome._tag === "Incompatible") {
          yield* update(name, (connector) => ({ ...connector, process: "failing" }))
          yield* Effect.logError("connector incompatible", Cause.fail(outcome.reason))
          return
        }
        const ran = DateTime.toEpochMillis(yield* DateTime.now) - startedAt
        failures = ran >= Duration.toMillis(restartPolicy.stableAfter) ? 1 : failures + 1
        const state = failures >= restartPolicy.failingAfter ? "failing" : "restarting"
        yield* update(name, (connector) => ({ ...connector, process: connector.process === "failing" ? "failing" : state }))
        const delay = backoff(failures)
        yield* Effect.logWarning("connector crashed", Cause.fail(outcome.reason)).pipe(
          Effect.annotateLogs({ failures, state, retryInMs: Duration.toMillis(delay) })
        )
        yield* Effect.sleep(delay)
      }
    }).pipe(
      Effect.onInterrupt(() => Effect.logInfo("connector supervision ended")),
      Effect.annotateLogs({ connector: name })
    )

  /** A third-party connector returns to inert, an official one that no longer matches too, a dev one restarts. */
  const filesChanged = (name: Ids.ConnectorName, at: string, onlyIfDigestDiffers: boolean) =>
    Effect.gen(function*() {
      const installed = yield* Effect.option(directory.read(at))
      const connector = yield* connectors.find(name)
      if (Option.isNone(connector)) return
      if (Option.isSome(installed)) {
        const same = installed.value.digest === connector.value.digest
        if (same && (onlyIfDigestDiffers || connector.value.trust !== "dev")) return
      } else if (connector.value.trust === "inert") {
        return
      }
      // Files that can no longer be read count as changed; the digest stays the last one read.
      const digest = Option.match(installed, { onNone: () => connector.value.digest, onSome: (i) => i.digest })
      const version = Option.match(installed, { onNone: () => connector.value.version, onSome: (i) => i.version })
      const result = ConnectorRules.filesChanged(connector.value, digest)
      yield* update(name, () => ({ ...result.connector, version }))
      yield* Effect.forEach(Option.toArray(result.alert), (alert) => Effect.ignore(alerts.show(alert)), {
        discard: true
      })
      if (result.restart) yield* restartRun(name)
      else yield* stopRun(name)
    })

  const connectorPath = (connector: Connector.Connector) =>
    connector.origin._tag === "DevLink"
      ? Effect.succeedSome(connector.origin.path)
      : Effect.map(
        Effect.orElseSucceed(directory.list, () => []),
        (all) => Option.map(Option.fromNullishOr(all.find((i) => i.name === connector.name)), (i) => i.directory)
      )

  const watchFiles = (connector: Connector.Connector) =>
    Effect.gen(function*() {
      const at = yield* connectorPath(connector)
      if (Option.isNone(at)) return
      yield* FiberMap.run(
        fileWatches,
        connector.name,
        directory.changes(at.value).pipe(
          Stream.runForEach(() => filesChanged(connector.name, at.value, false)),
          Effect.ignore
        )
      )
    })

  const restartRun = (name: Ids.ConnectorName) =>
    Effect.gen(function*() {
      yield* FiberMap.remove(runs, name)
      const connector = yield* connectors.find(name)
      if (Option.isNone(connector) || connector.value.trust === "inert") {
        yield* update(name, (p) => ({ ...p, process: "stopped" }))
        return
      }
      yield* update(name, (p) => ({ ...p, process: p.process === "failing" ? "failing" : "stopped" }))
      yield* FiberMap.run(runs, name, supervise(name))
    })

  const stopRun = (name: Ids.ConnectorName) =>
    Effect.andThen(FiberMap.remove(runs, name), update(name, (p) => ({ ...p, process: "stopped" })))

  const restart = (name: Ids.ConnectorName) =>
    Effect.gen(function*() {
      const connector = yield* connectors.find(name)
      if (Option.isNone(connector)) return yield* stop(name)
      if (!(yield* FiberMap.has(fileWatches, name))) yield* watchFiles(connector.value)
      yield* restartRun(name)
    })

  const stop = (name: Ids.ConnectorName) =>
    Effect.gen(function*() {
      yield* FiberMap.remove(fileWatches, name)
      yield* FiberMap.remove(runs, name)
      yield* update(name, (p) => ({ ...p, process: "stopped" }))
    })

  const reconfigure = (name: Ids.ConnectorName) =>
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
      const connector = yield* connectors.find(name)
      if (Option.isNone(connector)) return { _tag: "Missing" } as Connector.Configuration
      if (connector.value.catalogue === undefined) return connector.value.configuration
      const { configuration } = yield* configurationOf(name, connector.value.catalogue)
      yield* update(name, (p) => ({ ...p, configuration }))
      return configuration
    })

  /** Still starting: trusted, not failing, and either without a catalogue yet or not running yet. */
  const starting = (connector: Connector.Connector) =>
    connector.trust !== "inert" &&
    connector.process !== "failing" &&
    (connector.catalogue === undefined ||
      (connector.configuration._tag !== "Rejected" && connector.process !== "running"))

  const ready = (name: Ids.ConnectorName) =>
    Effect.gen(function*() {
      while (true) {
        const wake = yield* Ref.get(changed)
        const connector = yield* connectors.find(name)
        if (Option.isNone(connector)) {
          return yield* new Refusal.ConnectorUnavailable({ connector: name, problem: "it is not installed" })
        }
        const running = (yield* Ref.get(processes)).get(name)
        if (ConnectorRules.isAvailable(connector.value) && running !== undefined) return running
        if (!starting(connector.value)) {
          const reason = Option.getOrElse(ConnectorRules.problem(connector.value), () => "it is not running")
          return yield* new Refusal.ConnectorUnavailable({ connector: name, problem: reason })
        }
        yield* Deferred.await(wake)
      }
    }).pipe(
      Effect.timeoutOption(startTimeout),
      Effect.flatMap(Option.match({
        onNone: () => Effect.fail(new Refusal.ConnectorUnavailable({ connector: name, problem: "it did not start in time" })),
        onSome: Effect.succeed
      }))
    )

  const removedPrefix = "unavailable since "

  const reportRemovedAfter = (name: Ids.ConnectorName, since: DateTime.Utc, problem: string) =>
    FiberMap.run(timers, name, Effect.gen(function*() {
      const elapsed = DateTime.toEpochMillis(yield* DateTime.now) - DateTime.toEpochMillis(since)
      yield* Effect.sleep(Duration.max(Duration.subtract((yield* limits).unavailableBeforeWake, Duration.millis(elapsed)), Duration.zero))
      if (Option.isNone(yield* connectors.find(name))) yield* intake.connectorRemoved(name, since, problem)
    }))

  const remove = (name: Ids.ConnectorName, change: ConnectorChange, problem: string) =>
    Effect.gen(function*() {
      yield* stop(name)
      yield* writes.withPermit(Effect.gen(function*() {
        const before = yield* connectors.find(name)
        const since = Option.match(before, {
          onNone: () => change.at,
          onSome: (connector) => connector.unavailableSince ?? change.at
        })
        yield* connectors.remove(name, { ...change, detail: `${removedPrefix}${DateTime.formatIso(since)}; ${problem}` })
        yield* FiberMap.remove(timers, name)
        icons.delete(name)
        yield* closeStreams(name)
        yield* intake.connectorRemoved(name, since, problem)
        yield* reportRemovedAfter(name, since, problem)
        yield* signal
      }))
    })

  /** After a restart: the removal timer for each removed connector that still has subscriptions. */
  const rearmRemoved = Effect.gen(function*() {
    const names = new Set((yield* subscriptions.list({ states: ["Active"] })).map((subscription) => subscription.connector))
    for (const name of names) {
      if (Option.isSome(yield* connectors.find(name))) continue
      const last = (yield* connectors.changes(name)).filter((c) => c.kind === "remove" || c.kind === "dev-unlink").at(-1)
      const detail = last?.detail
      if (detail === undefined || !detail.startsWith(removedPrefix)) continue
      const [iso, ...rest] = detail.slice(removedPrefix.length).split("; ")
      const since = DateTime.make(iso!)
      if (Option.isSome(since)) yield* reportRemovedAfter(name, DateTime.toUtc(since.value), rest.join("; "))
    }
  })

  const startup = Effect.gen(function*() {
    yield* rearmRemoved
    for (const stored of yield* connectors.list) {
      const at = yield* connectorPath(stored)
      if (Option.isSome(at)) yield* filesChanged(stored.name, at.value, true)
      const connector = Option.getOrElse(yield* connectors.find(stored.name), () => stored)
      if (connector.unavailableSince !== undefined) yield* suspendAfter(connector.name, connector.unavailableSince)
      yield* watchFiles(connector)
      if (connector.trust !== "inert" && !(yield* FiberMap.has(runs, connector.name))) yield* restartRun(connector.name)
    }
  })
  // Each change to one name holds one permit of `everyName` and its own name's lock; an import holds them all.
  const allPermits = 1_000_000
  const everyName = yield* Semaphore.make(allPermits)
  const nameLocks = new Map<string, Semaphore.Semaphore>()
  const nameLock = (name: Ids.ConnectorName) => {
    const existing = nameLocks.get(name)
    if (existing !== undefined) return existing
    const created = Semaphore.makeUnsafe(1)
    nameLocks.set(name, created)
    return created
  }
  const startedSignal = yield* Deferred.make<void>()
  yield* Effect.forkScoped(Effect.ensuring(startup, Deferred.succeed(startedSignal, undefined)))

  const rewatch = (subscription: Ids.SubscriptionId) =>
    Effect.andThen(FiberMap.remove(streams, subscription), openStream(subscription))

  const refresh = Effect.gen(function*() {
    const { wakeWindow } = yield* limits
    const opened = yield* Ref.get(openedWith)
    const stale = Array.from(streams, ([id]) => id).filter((id) => {
      const used = opened.get(id)
      return used === undefined || !Duration.equals(used, wakeWindow)
    })
    yield* Effect.forEach(stale, rewatch, { discard: true })
  })

  return ConnectorSupervisor.of({
    store,
    update,
    restart,
    stop,
    remove,
    reconfigure,
    ready,
    status,
    watch: openStream,
    // The intake may unwatch from inside the stream's own ingest, so the removal runs on its own fiber.
    unwatch: (subscription) => Effect.asVoid(Effect.forkDetach(FiberMap.remove(streams, subscription))),
    rewatch,
    settingsChanged: Effect.asVoid(Effect.forkIn(refreshes.withPermit(refresh), scope)),
    exclusiveFor: (name, effect) => everyName.withPermits(1)(nameLock(name).withPermits(1)(effect)),
    exclusive: (effect) => everyName.withPermits(allPermits)(effect),
    started: Deferred.await(startedSignal)
  })
}))
