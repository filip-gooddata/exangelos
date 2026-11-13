import { DateTime, Effect, Layer, Option } from "effect"
import { type Ids, type Connector, ConnectorRules, Refusal, type Session, Subscribe } from "@exangelos/domain"
import { AlertSink } from "../ports/AlertSink.ts"
import { OfficialConnectorSource } from "../ports/OfficialConnectorSource.ts"
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
      yield* Effect.ignore((yield* AlertSink).show(alert.value))
      return yield* new Refusal.ConnectorUnavailable({
        connector: name,
        problem: "its checksum does not match the one this binary carries"
      })
    }
    yield* supervisor.restart(name)
  })

/** The real ConnectorAccess over the supervisor. */
export const layerConnectorAccess: Layer.Layer<
  ConnectorAccess,
  never,
  ConnectorSupervisor | ConnectorRepository | OfficialConnectorSource | ConnectorDirectory | AlertSink
> = Layer.effect(ConnectorAccess, Effect.gen(function*() {
  const supervisor = yield* ConnectorSupervisor
  const repository = yield* ConnectorRepository
  const context = yield* Effect.context<OfficialConnectorSource | ConnectorDirectory | AlertSink | ConnectorSupervisor | ConnectorRepository>()
  return ConnectorAccess.of({
    describe: (actor, name, request) =>
      Effect.gen(function*() {
        if (Option.isNone(yield* repository.find(name))) {
          yield* Effect.provide(fetchOfficial(actor, name), context)
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
    rewatch: supervisor.rewatch
  })
}))
