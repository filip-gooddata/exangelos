import { Cause, DateTime, Effect, Option, Redacted, Schema } from "effect"
import { Catalogue, Ids, Connector, ConnectorRules, Refusal, Session, Settings } from "@exangelos/domain"
import { AlertSink } from "../ports/AlertSink.ts"
import { ConnectorDirectory } from "../ports/ConnectorDirectory.ts"
import { ImportFailed, ConnectorImportSource, type Source } from "../ports/ConnectorImportSource.ts"
import { ConnectorRepository, type ConnectorChange, type ConnectorChangeKind } from "../ports/ConnectorRepository.ts"
import { SecretStore, type SecretStoreFailed } from "../ports/SecretStore.ts"
import { ServiceManager } from "../ports/ServiceManager.ts"
import { SettingsStore } from "../ports/SettingsStore.ts"
import { ConnectorNotFound } from "../seam/ConnectorAccess.ts"
import { listConnectorAlerts } from "./listConnectorAlerts.ts"
import { ConnectorSupervisor } from "./ConnectorSupervisor.ts"
import { redact } from "./redact.ts"
import { removeHarness, setHarness } from "../settings/harnesses.ts"

export class DigestMismatch extends Schema.TaggedError<DigestMismatch>()("DigestMismatch", {
  connector: Ids.ConnectorName,
  expected: Schema.String,
  actual: Schema.String
}) {}

export class HumanRequired extends Schema.TaggedError<HumanRequired>()("HumanRequired", {
  connector: Ids.ConnectorName
}) {}

export class SettingsOwnerOnly extends Schema.TaggedError<SettingsOwnerOnly>()("SettingsOwnerOnly", {}) {}

export class ConfigurationInvalid extends Schema.TaggedError<ConfigurationInvalid>()("ConfigurationInvalid", {
  connector: Ids.ConnectorName,
  reason: Schema.String
}) {}

export class ConfigurationRejected extends Schema.TaggedError<ConfigurationRejected>()("ConfigurationRejected", {
  connector: Ids.ConnectorName,
  reason: Schema.String
}) {}

const change = (connector: Ids.ConnectorName, kind: ConnectorChangeKind, actor: Session.Actor, detail?: string) =>
  Effect.map(DateTime.now, (at): ConnectorChange => ({ connector, kind, actor, at, ...(detail === undefined ? {} : { detail }) }))

const found = (name: Ids.ConnectorName) =>
  Effect.flatMap(ConnectorRepository.use((repository) => repository.find(name)), Option.match({
    onNone: () => Effect.fail(new ConnectorNotFound({ connector: name })),
    onSome: Effect.succeed
  }))

const stored = (name: Ids.ConnectorName) => Effect.flatMap(ConnectorRepository.use((r) => r.find(name)), Effect.fromOption)

const originOf = (source: Source): Connector.Origin => source

/**
 * Places the connector in the connector directory and records it inert, with its origin and digest. A
 * connector of the same name is replaced and stopped; its configuration stays.
 */
/** Runs an import or dev link, whose name is known only once placed, while no other connector change runs. */
const exclusively = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.flatMap(ConnectorSupervisor, (supervisor) => supervisor.exclusive(effect))

/** Runs a change to one connector's files or trust while no other change to that name, or import, runs. */
const exclusivelyFor = (name: Ids.ConnectorName) => <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.flatMap(ConnectorSupervisor, (supervisor) => supervisor.exclusiveFor(name, effect))

export const importConnector = (actor: Session.Actor, source: Source) =>
  exclusively(Effect.gen(function*() {
    const supervisor = yield* ConnectorSupervisor
    const directory = yield* ConnectorDirectory
    const placed = yield* (yield* ConnectorImportSource).place(source)
    const installed = yield* Effect.mapError(directory.read(placed), (e) => new ImportFailed({ reason: e.reason }))
    const before = yield* ConnectorRepository.use((r) => r.find(installed.name))
    yield* supervisor.stop(installed.name)
    const connector: Connector.Connector = {
      name: installed.name,
      version: installed.version,
      origin: originOf(source),
      digest: installed.digest,
      trust: "inert",
      configuration: Option.match(before, { onNone: () => ({ _tag: "Missing" }), onSome: (p) => p.configuration }),
      process: "stopped",
      ...Option.match(before, {
        onNone: () => ({}),
        onSome: (p) => ({
          ...(p.catalogue === undefined ? {} : { catalogue: p.catalogue }),
          ...(p.configuredBy === undefined ? {} : { configuredBy: p.configuredBy })
        })
      })
    }
    yield* supervisor.store(connector, yield* change(connector.name, "import", actor, `${source._tag} ${installed.digest}`))
    yield* Effect.logInfo("connector imported").pipe(Effect.annotateLogs({
      connector: connector.name,
      source: source._tag,
      digest: installed.digest,
      replaced: Option.isSome(before)
    }))
    const alert = ConnectorRules.trustAlert(connector, Option.none())
    if (Option.isSome(alert)) yield* Effect.ignore((yield* AlertSink).show(alert.value))
    yield* supervisor.restart(connector.name)
    return yield* stored(connector.name)
  }))

/** Enables the connector after you saw its digest; refused when its files changed since. */
export const enableConnector = (actor: Session.Actor, name: Ids.ConnectorName, digest: string) =>
  exclusivelyFor(name)(Effect.gen(function*() {
    if (actor._tag !== "You") return yield* new HumanRequired({ connector: name })
    const supervisor = yield* ConnectorSupervisor
    const connector = yield* found(name)
    if (connector.digest !== digest) {
      yield* Effect.logWarning("connector digest mismatch", Cause.fail("DigestMismatch")).pipe(
        Effect.annotateLogs({ actual: connector.digest })
      )
      return yield* new DigestMismatch({ connector: name, expected: digest, actual: connector.digest })
    }
    if (connector.trust !== "inert") return connector
    // Checked again under the write permit, so a file change racing this call cannot be trusted.
    const enabled = yield* supervisor.update(
      name,
      (p) => p.digest === digest && p.trust === "inert" ? { ...p, trust: "enabled" } : undefined,
      yield* change(name, "enable", actor, digest)
    )
    if (Option.isNone(enabled)) {
      const now = yield* found(name)
      if (now.digest !== digest) {
        yield* Effect.logWarning("connector digest mismatch", Cause.fail("DigestMismatch")).pipe(
          Effect.annotateLogs({ actual: now.digest })
        )
        return yield* new DigestMismatch({ connector: name, expected: digest, actual: now.digest })
      }
      return now
    }
    yield* Effect.logInfo("connector enabled").pipe(Effect.annotateLogs({ digest }))
    yield* supervisor.restart(name)
    return yield* stored(name)
  }).pipe(Effect.annotateLogs({ connector: name })))

export const disableConnector = (actor: Session.Actor, name: Ids.ConnectorName) =>
  exclusivelyFor(name)(Effect.gen(function*() {
    const supervisor = yield* ConnectorSupervisor
    const connector = yield* found(name)
    if (connector.trust === "inert") return connector
    yield* supervisor.update(name, (p) => ({ ...p, trust: "inert" }), yield* change(name, "disable", actor))
    yield* supervisor.restart(name)
    return yield* stored(name)
  }))

const secretFields = (connector: Connector.Connector) =>
  (connector.catalogue?.configuration ?? []).filter((field) => field._tag === "Secret").map((field) => field.key)

const forget = (connector: Connector.Connector, kind: "remove" | "dev-unlink", actor: Session.Actor) =>
  Effect.gen(function*() {
    const supervisor = yield* ConnectorSupervisor
    yield* Effect.ignore((yield* SecretStore).delete(connector.name, secretFields(connector)))
    if (connector.origin._tag !== "DevLink") {
      yield* Effect.ignore((yield* ConnectorDirectory).remove(connector.name))
    }
    yield* supervisor.remove(
      connector.name,
      yield* change(connector.name, kind, actor),
      kind === "remove" ? "removed by you" : "unlinked by you"
    )
  })

/** Stops the connector and deletes its files, record, configuration and secrets. Its change log stays. */
export const removeConnector = (actor: Session.Actor, name: Ids.ConnectorName) =>
  exclusivelyFor(name)(Effect.flatMap(found(name), (connector) => forget(connector, "remove", actor)))

const validate = (name: Ids.ConnectorName, catalogue: Catalogue.Catalogue, values: Catalogue.ConfigurationValues) =>
  Effect.gen(function*() {
    for (const key of Object.keys(values)) {
      const field = catalogue.configuration.find((f) => f.key === key)
      if (field === undefined) return yield* new ConfigurationInvalid({ connector: name, reason: `unknown field ${key}` })
      if (field._tag === "Choice" && !field.choices.includes(values[key]!)) {
        return yield* new ConfigurationInvalid({
          connector: name,
          reason: `${key} must be one of ${field.choices.join(", ")}`
        })
      }
    }
  })

/**
 * Validates the values against the catalogue, stores text and choice fields in the repository and
 * secret fields in the SecretStore, and sends Configure to the running process. A field omitted
 * keeps its stored value. Changing a field that says where secrets are sent clears the stored
 * secrets first. Rejected credentials leave the configuration rejected and fail the call.
 */
export const configureConnector = (actor: Session.Actor, name: Ids.ConnectorName, values: Catalogue.ConfigurationValues) =>
  Effect.gen(function*() {
    const supervisor = yield* ConnectorSupervisor
    const repository = yield* ConnectorRepository
    const secrets = yield* SecretStore
    const connector = yield* found(name)
    const catalogue = connector.catalogue
    if (catalogue === undefined) {
      return yield* new Refusal.ConnectorUnavailable({ connector: name, problem: "it has not run yet, so its form is unknown" })
    }
    yield* validate(name, catalogue, values)
    const secretKeys = secretFields(connector)
    const before = yield* repository.values(name)
    const after: Record<string, string> = { ...before }
    for (const [key, value] of Object.entries(values)) if (!secretKeys.includes(key)) after[key] = value
    const cleared = ConnectorRules.clearsSecrets(catalogue, before, after)
    const storeSecrets = Effect.gen(function*() {
      if (cleared) yield* secrets.delete(name, secretKeys)
      for (const [key, value] of Object.entries(values)) {
        if (secretKeys.includes(key)) yield* secrets.set(name, key, Redacted.make(value))
      }
    })
    // The store's own reason could quote the value it refused, so every given secret is replaced first.
    const given = Object.entries(values).filter(([key]) => secretKeys.includes(key)).map(([, value]) => value)
    yield* Effect.mapError(storeSecrets, (e: SecretStoreFailed) =>
      new ConfigurationInvalid({
        connector: name,
        reason: `the secret store refused it: ${
          redact(e.reason, given)
        }`
      }))
    yield* repository.storeValues(name, after)
    const fields = Object.keys(values).sort().join(", ")
    yield* supervisor.update(
      name,
      (p) => ({ ...p, configuredBy: actor }),
      yield* change(name, "configure", actor, cleared ? `${fields}; stored secrets cleared` : fields)
    )
    const configuration = yield* supervisor.reconfigure(name)
    if (configuration._tag === "Rejected") {
      return yield* new ConfigurationRejected({ connector: name, reason: configuration.reason })
    }
    return yield* stored(name)
  })

/** Trusts a working directory as a dev connector while linked and starts it. CLI only. */
export const devLink = (actor: Session.Actor, path: string) =>
  exclusively(Effect.gen(function*() {
    const supervisor = yield* ConnectorSupervisor
    const installed = yield* Effect.mapError(
      (yield* ConnectorDirectory).read(path),
      (e) => new ImportFailed({ reason: e.reason })
    )
    const existing = yield* ConnectorRepository.use((r) => r.find(installed.name))
    if (Option.isSome(existing) && existing.value.origin._tag !== "DevLink") {
      return yield* new ImportFailed({ reason: `${installed.name} is installed; remove it before linking` })
    }
    yield* supervisor.stop(installed.name)
    yield* supervisor.store({
      name: installed.name,
      version: installed.version,
      origin: { _tag: "DevLink", path: installed.directory },
      digest: installed.digest,
      trust: "dev",
      configuration: Option.match(existing, { onNone: () => ({ _tag: "Missing" }), onSome: (p) => p.configuration }),
      process: "stopped"
    }, yield* change(installed.name, "dev-link", actor, installed.directory))
    yield* Effect.logInfo("connector dev-linked").pipe(
      Effect.annotateLogs({ connector: installed.name, target: installed.directory })
    )
    yield* supervisor.restart(installed.name)
    return yield* stored(installed.name)
  }))

export const devUnlink = (actor: Session.Actor, name: Ids.ConnectorName) =>
  exclusivelyFor(name)(Effect.gen(function*() {
    const connector = yield* found(name)
    if (connector.origin._tag !== "DevLink") return yield* new ConnectorNotFound({ connector: name })
    yield* forget(connector, "dev-unlink", actor)
  }))

export const getSettings = SettingsStore.use((store) => store.read)

export const setSettings = (actor: Session.Actor, settings: Settings.Settings) =>
  Effect.gen(function*() {
    if (actor._tag !== "You") return yield* new SettingsOwnerOnly()
    const written = yield* (yield* SettingsStore).update((current) =>
      Effect.succeed({ ...settings, harnesses: current.harnesses })
    )
    yield* (yield* ConnectorSupervisor).settingsChanged
    return written
  })

/** Whether the daemon service runs and how it started; the caller adds its own version. */
export const serviceStatus = ServiceManager.use((manager) => manager.status)

/** The management group's use cases by contract method. None is offered to the agent group. */
export const management = {
  ImportConnector: importConnector,
  EnableConnector: enableConnector,
  DisableConnector: disableConnector,
  RemoveConnector: removeConnector,
  ConfigureConnector: configureConnector,
  DevLink: devLink,
  DevUnlink: devUnlink,
  ListConnectorAlerts: listConnectorAlerts,
  GetSettings: getSettings,
  SetSettings: setSettings,
  SetHarness: setHarness,
  RemoveHarness: removeHarness,
  ServiceStatus: serviceStatus
} as const
