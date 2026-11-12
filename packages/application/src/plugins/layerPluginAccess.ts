import { DateTime, Effect, Layer, Option } from "effect"
import { type Ids, type Plugin, PluginRules, type Session } from "@exangelos/domain"
import { AlertSink } from "../ports/AlertSink.ts"
import { OfficialPluginSource } from "../ports/OfficialPluginSource.ts"
import { PluginDirectory } from "../ports/PluginDirectory.ts"
import { PluginRepository } from "../ports/PluginRepository.ts"
import { ParametersInvalid, PluginAccess, PluginNotFound, PluginUnavailable } from "../seam/PluginAccess.ts"
import { PluginSupervisor } from "./PluginSupervisor.ts"

/**
 * Fetches an official plugin on first use, records it, and enables it when its digest matches the
 * checksum the binary carries. A mismatch keeps it inert, raises the alert and fails.
 */
export const fetchOfficial = (actor: Session.Actor, name: Ids.PluginName) =>
  Effect.gen(function*() {
    const source = yield* OfficialPluginSource
    const official = source.known.find((known) => known.name === name)
    if (official === undefined) return yield* new PluginNotFound({ plugin: name })
    const placed = yield* source.fetch(official)
    const installed = yield* Effect.mapError(
      (yield* PluginDirectory).read(placed),
      (e) => new PluginUnavailable({ plugin: name, reason: `its archive is unreadable: ${e.reason}` })
    )
    const checksum = Option.some(official.digest)
    const origin = { _tag: "Official", version: official.version } as const
    const supervisor = yield* PluginSupervisor
    const plugin: Plugin.Plugin = {
      name,
      version: installed.version,
      origin,
      digest: installed.digest,
      trust: PluginRules.initialTrust(origin, installed.digest, checksum),
      configuration: { _tag: "Missing" },
      process: "stopped"
    }
    yield* supervisor.store(plugin, { plugin: name, kind: "fetch", actor, at: yield* DateTime.now, detail: installed.digest })
    const alert = PluginRules.trustAlert(plugin, checksum)
    if (Option.isSome(alert)) {
      yield* Effect.ignore((yield* AlertSink).show(alert.value))
      return yield* new PluginUnavailable({ plugin: name, reason: "its checksum does not match the one this binary carries" })
    }
    yield* supervisor.restart(name)
  })

/** The real PluginAccess over the supervisor. */
export const layerPluginAccess: Layer.Layer<
  PluginAccess,
  never,
  PluginSupervisor | PluginRepository | OfficialPluginSource | PluginDirectory | AlertSink
> = Layer.effect(PluginAccess, Effect.gen(function*() {
  const supervisor = yield* PluginSupervisor
  const repository = yield* PluginRepository
  const context = yield* Effect.context<OfficialPluginSource | PluginDirectory | AlertSink | PluginSupervisor | PluginRepository>()
  return PluginAccess.of({
    describe: (actor, name, parameters) =>
      Effect.gen(function*() {
        if (Option.isNone(yield* repository.find(name))) {
          yield* Effect.provide(fetchOfficial(actor, name), context)
        }
        const process = yield* supervisor.ready(name)
        const answer = yield* Effect.mapError(
          process.describe(parameters),
          (crash) => new PluginUnavailable({ plugin: name, reason: crash.reason })
        )
        if (answer._tag === "Invalid") return yield* new ParametersInvalid({ plugin: name, reason: answer.reason })
        return {
          catalogue: process.catalogue,
          parameters: answer.parameters,
          subject: answer.subject,
          label: answer.label
        }
      }),
    watch: supervisor.watch,
    unwatch: supervisor.unwatch
  })
}))
