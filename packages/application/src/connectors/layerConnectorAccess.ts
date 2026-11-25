import { Cause, Clock, DateTime, Duration, Effect, Layer, Option, Ref } from "effect"
import { type Ids, type Connector, ConnectorRules, Refusal, type Session, Subscribe } from "@exangelos/domain"
import { AlertSink } from "../ports/AlertSink.ts"
import { type Earlier, OfficialConnectorSource, type Official } from "../ports/OfficialConnectorSource.ts"
import { ConnectorDirectory } from "../ports/ConnectorDirectory.ts"
import { ConnectorRepository } from "../ports/ConnectorRepository.ts"
import { ConnectorAccess, ConnectorNotFound } from "../seam/ConnectorAccess.ts"
import { ConnectorSupervisor } from "./ConnectorSupervisor.ts"

/**
 * Fetches an official connector on first use, records it, and enables it when its digest matches the
 * checksum the binary carries. A mismatch keeps it inert, raises the alert and fails.
 */
export const fetchOfficial = (actor: Session.Actor, name: Ids.ConnectorName) =>
  Effect.gen(function*() {
    const source = yield* OfficialConnectorSource
    const official = source.known.find((known) => known.name === name)
    if (official === undefined) return yield* new ConnectorNotFound({ connector: name })
    const placed = yield* source.fetch(official)
    const installed = yield* Effect.mapError(
      (yield* ConnectorDirectory).read(placed),
      (e) => new Refusal.ConnectorUnavailable({ connector: name, problem: `its archive is unreadable: ${e.reason}` })
    )
    const checksum = Option.some(official.digest)
    const origin = { _tag: "Official", version: official.version } as const
    const supervisor = yield* ConnectorSupervisor
    const connector: Connector.Connector = {
      name,
      version: installed.version,
      origin,
      digest: installed.digest,
      trust: ConnectorRules.initialTrust(origin, installed.digest, checksum),
      configuration: { _tag: "Missing" },
      process: "stopped"
    }
    yield* supervisor.store(connector, { connector: name, kind: "fetch", actor, at: yield* DateTime.now, detail: installed.digest })
    const alert = ConnectorRules.trustAlert(connector, checksum)
    if (Option.isSome(alert)) {
      const unavailable = new Refusal.ConnectorUnavailable({
        connector: name,
        problem: "its checksum does not match the one this binary carries"
      })
      yield* Effect.logError("official connector digest mismatch", Cause.fail(unavailable)).pipe(
        Effect.annotateLogs({ expected: official.digest, actual: installed.digest, trust: connector.trust })
      )
      yield* Effect.ignore((yield* AlertSink).show(alert.value))
      return yield* unavailable
    }
    yield* Effect.logInfo("official connector digest matched").pipe(
      Effect.annotateLogs({ version: installed.version, trust: connector.trust })
    )
    yield* supervisor.restart(name)
  }).pipe(Effect.annotateLogs({ connector: name }))

/** An official record the binary now carries in another version, or with another digest. */
const outdated = (connector: Connector.Connector, official: Official) =>
  connector.origin._tag === "Official" &&
  (connector.origin.version !== official.version || connector.digest !== official.digest)

/**
 * Replaces an installed official connector whose version or digest differs from the one this binary
 * carries. The new copy goes in only once its digest matches; the record keeps its trust, configuration
 * and subscriptions, so a disabled connector is refreshed and stays disabled. When the fetch, the check or
 * the start fails, or the refresh is interrupted, the earlier copy and record come back and the failure is
 * returned for a later retry. The earlier version and digest are kept with the earlier copy until the
 * record says them again, so a rollback that could not finish is finished by the next refresh. It runs
 * exclusively of other changes to that connector and of imports, and never touches a connector imported
 * or dev-linked.
 */
export const refreshOfficial = (official: Official) =>
  Effect.gen(function*() {
    const name = official.name
    const supervisor = yield* ConnectorSupervisor
    const repository = yield* ConnectorRepository
    const directory = yield* ConnectorDirectory
    const source = yield* OfficialConnectorSource
    const unavailable = (problem: string) => new Refusal.ConnectorUnavailable({ connector: name, problem })
    const isOfficial = (connector: Connector.Connector) => connector.origin._tag === "Official"

    /** Gives the record back the earlier version and digest, then lets the kept copy go. */
    const settleBack = (earlier: Earlier) =>
      Effect.andThen(
        supervisor.update(name, (connector) =>
          isOfficial(connector)
            ? { ...connector, version: earlier.version, digest: earlier.digest, origin: { _tag: "Official", version: earlier.release } }
            : undefined),
        Effect.mapError(source.discard(official), (failed) => unavailable(failed.reason))
      )

    /** Finishes a rollback an earlier refresh could not: files first, then the record, then the kept copy. */
    const recover = Effect.gen(function*() {
      const pending = yield* Effect.mapError(source.kept(official), (failed) => unavailable(failed.reason))
      if (Option.isNone(pending)) return
      yield* supervisor.stop(name)
      yield* source.restore(official).pipe(
        Effect.mapError((failed) => unavailable(`an earlier copy could not be put back: ${failed.reason}`)),
        Effect.onError(() => supervisor.restart(name))
      )
      yield* settleBack(pending.value)
      yield* Effect.logInfo("official connector earlier copy put back").pipe(
        Effect.annotateLogs({ version: pending.value.version })
      )
      yield* supervisor.restart(name)
    })

    yield* supervisor.exclusiveFor(name, Effect.uninterruptibleMask((interruptible) =>
      Effect.gen(function*() {
        if (!Option.exists(yield* repository.find(name), isOfficial)) return
        yield* recover
        const found = yield* repository.find(name)
        if (Option.isNone(found) || !outdated(found.value, official)) return
        const earlier = found.value
        const kept: Earlier = {
          version: earlier.version,
          digest: earlier.digest,
          release: earlier.origin._tag === "Official" ? earlier.origin.version : earlier.version
        }

        yield* supervisor.stop(name)

        const adopt = Effect.gen(function*() {
          const placed = yield* Effect.mapError(
            source.replace(official, kept),
            (failed) => unavailable(failed.reason)
          )
          const installed = yield* Effect.mapError(directory.read(placed), (e) => unavailable(e.reason))
          yield* supervisor.update(name, (connector) => ({
            ...connector,
            version: installed.version,
            digest: installed.digest,
            origin: { _tag: "Official", version: official.version }
          }))
          yield* supervisor.restart(name)
          const current = yield* repository.find(name)
          if (Option.exists(current, (connector) => connector.trust === "inert")) return
          // ready gives up after the supervisor's start timeout; only a running process counts as started.
          const refused = yield* Effect.flip(supervisor.ready(name)).pipe(Effect.option)
          const now = yield* repository.find(name)
          if (!Option.exists(now, (connector) => connector.process === "running")) {
            return yield* unavailable(
              Option.getOrElse(Option.map(refused, (r) => r.problem), () => "it did not start")
            )
          }
        })

        // The record goes back only once the files have; a failure leaves the kept copy for `recover`.
        const rollback = Effect.gen(function*() {
          yield* supervisor.stop(name)
          yield* source.restore(official).pipe(
            Effect.andThen(settleBack(kept)),
            Effect.catch((failed) =>
              Effect.logError("official connector earlier copy not restored; the next refresh puts it back", Cause.fail(failed)))
          )
          yield* supervisor.restart(name)
        })

        yield* interruptible(adopt).pipe(Effect.onError(() => rollback))
        // Until the state is retired, the next refresh would take it for a rollback to finish.
        yield* Effect.mapError(source.discard(official), (failed) =>
          unavailable(`the new copy runs, but the earlier one could not be let go, so the next refresh puts it back: ${failed.reason}`))
        yield* Effect.logInfo("official connector refreshed").pipe(
          Effect.annotateLogs({ from: earlier.version, to: official.version, digest: official.digest })
        )
      })
    ))
  }).pipe(
    Effect.tapError((failed) =>
      Effect.logWarning("official connector refresh failed; the installed copy stays", Cause.fail(failed)).pipe(
        Effect.annotateLogs({ to: official.version })
      )),
    Effect.annotateLogs({ connector: official.name })
  )

/** How long after a failed refresh the same version is tried again on use. Daemon start always tries. */
export const refreshRetryAfter = Duration.minutes(10)

/** The real ConnectorAccess over the supervisor. */
export const layerConnectorAccess: Layer.Layer<
  ConnectorAccess,
  never,
  ConnectorSupervisor | ConnectorRepository | OfficialConnectorSource | ConnectorDirectory | AlertSink
> = Layer.effect(ConnectorAccess, Effect.gen(function*() {
  const supervisor = yield* ConnectorSupervisor
  const repository = yield* ConnectorRepository
  const context = yield* Effect.context<OfficialConnectorSource | ConnectorDirectory | AlertSink | ConnectorSupervisor | ConnectorRepository>()
  const officialSource = yield* OfficialConnectorSource
  const known = officialSource.known
  const failedAt = yield* Ref.make(new Map<string, number>())

  /** Refreshes one official connector, at most once per retry window after a failure unless `always`. */
  const refresh = (official: Official, always: boolean) =>
    Effect.gen(function*() {
      const key = `${official.name}@${official.version}@${official.digest}`
      const now = yield* Clock.currentTimeMillis
      const last = (yield* Ref.get(failedAt)).get(key)
      if (!always && last !== undefined && now - last < Duration.toMillis(refreshRetryAfter)) return
      yield* refreshOfficial(official).pipe(
        Effect.tap(() => Ref.update(failedAt, (m) => { const next = new Map(m); next.delete(key); return next })),
        Effect.catch(() => Ref.update(failedAt, (m) => new Map(m).set(key, now))),
        Effect.provide(context)
      )
    })

  yield* Effect.forkScoped(
    Effect.andThen(supervisor.started, Effect.forEach(known, (official) => refresh(official, true), { discard: true }))
  )

  return ConnectorAccess.of({
    describe: (actor, name, request) =>
      Effect.gen(function*() {
        if (Option.isNone(yield* repository.find(name))) {
          yield* supervisor.exclusiveFor(name, Effect.gen(function*() {
            if (Option.isNone(yield* repository.find(name))) {
              // Rollback state left by an official copy removed since belongs to no record now.
              const official = known.find((candidate) => candidate.name === name)
              if (official !== undefined) {
                yield* Effect.mapError(officialSource.discard(official), (failed) =>
                  new Refusal.ConnectorUnavailable({ connector: name, problem: failed.reason }))
              }
              yield* Effect.provide(fetchOfficial(actor, name), context)
            }
          }))
        } else {
          const official = known.find((candidate) => candidate.name === name)
          if (official !== undefined) yield* refresh(official, false)
        }
        const process = yield* supervisor.ready(name)
        const parameters = yield* Effect.fromResult(
          Subscribe.withMain(request.parameters, process.catalogue.parameters.main, request.main)
        )
        const answer = yield* Effect.mapError(
          process.describe(parameters),
          (crash) => new Refusal.ConnectorUnavailable({ connector: name, problem: crash.reason })
        )
        if (answer._tag === "Invalid") return yield* new Refusal.ParametersInvalid({ reason: answer.reason })
        return {
          catalogue: process.catalogue,
          parameters: answer.parameters,
          subject: answer.subject,
          label: answer.label
        }
      }),
    watch: supervisor.watch,
    unwatch: supervisor.unwatch,
    rewatch: supervisor.rewatch,
    observation: (subscription) => Effect.sync(() => supervisor.observation(subscription))
  })
}))
