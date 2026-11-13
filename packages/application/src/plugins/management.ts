import { DateTime, Effect, Option, Redacted, Schema } from "effect"
import { Catalogue, Ids, Plugin, PluginRules, Refusal, Session, Settings } from "@exangelos/domain"
import { AlertSink } from "../ports/AlertSink.ts"
import { PluginDirectory } from "../ports/PluginDirectory.ts"
import { ImportFailed, PluginImportSource, type Source } from "../ports/PluginImportSource.ts"
import { PluginRepository, type PluginChange, type PluginChangeKind } from "../ports/PluginRepository.ts"
import { SecretStore, type SecretStoreFailed } from "../ports/SecretStore.ts"
import { ServiceManager } from "../ports/ServiceManager.ts"
import { SettingsStore } from "../ports/SettingsStore.ts"
import { PluginNotFound } from "../seam/PluginAccess.ts"
import { listPluginAlerts } from "./listPluginAlerts.ts"
import { PluginSupervisor } from "./PluginSupervisor.ts"
import { redact } from "./redact.ts"

export class DigestMismatch extends Schema.TaggedError<DigestMismatch>()("DigestMismatch", {
  plugin: Ids.PluginName,
  expected: Schema.String,
  actual: Schema.String
}) {}

export class HumanRequired extends Schema.TaggedError<HumanRequired>()("HumanRequired", {
  plugin: Ids.PluginName
}) {}

export class ConfigurationInvalid extends Schema.TaggedError<ConfigurationInvalid>()("ConfigurationInvalid", {
  plugin: Ids.PluginName,
  reason: Schema.String
}) {}

export class ConfigurationRejected extends Schema.TaggedError<ConfigurationRejected>()("ConfigurationRejected", {
  plugin: Ids.PluginName,
  reason: Schema.String
}) {}

const change = (plugin: Ids.PluginName, kind: PluginChangeKind, actor: Session.Actor, detail?: string) =>
  Effect.map(DateTime.now, (at): PluginChange => ({ plugin, kind, actor, at, ...(detail === undefined ? {} : { detail }) }))

const found = (name: Ids.PluginName) =>
  Effect.flatMap(PluginRepository.use((repository) => repository.find(name)), Option.match({
    onNone: () => Effect.fail(new PluginNotFound({ plugin: name })),
    onSome: Effect.succeed
  }))

const stored = (name: Ids.PluginName) => Effect.flatMap(PluginRepository.use((r) => r.find(name)), Effect.fromOption)

const originOf = (source: Source): Plugin.Origin => source

/**
 * Places the plugin in the plugin directory and records it inert, with its origin and digest. A
 * plugin of the same name is replaced and stopped; its configuration stays.
 */
export const importPlugin = (actor: Session.Actor, source: Source) =>
  Effect.gen(function*() {
    const supervisor = yield* PluginSupervisor
    const directory = yield* PluginDirectory
    const placed = yield* (yield* PluginImportSource).place(source)
    const installed = yield* Effect.mapError(directory.read(placed), (e) => new ImportFailed({ reason: e.reason }))
    const before = yield* PluginRepository.use((r) => r.find(installed.name))
    yield* supervisor.stop(installed.name)
    const plugin: Plugin.Plugin = {
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
    yield* supervisor.store(plugin, yield* change(plugin.name, "import", actor, `${source._tag} ${installed.digest}`))
    const alert = PluginRules.trustAlert(plugin, Option.none())
    if (Option.isSome(alert)) yield* Effect.ignore((yield* AlertSink).show(alert.value))
    yield* supervisor.restart(plugin.name)
    return yield* stored(plugin.name)
  })

/** Enables the plugin after you saw its digest; refused when its files changed since. */
export const enablePlugin = (actor: Session.Actor, name: Ids.PluginName, digest: string) =>
  Effect.gen(function*() {
    if (actor._tag !== "You") return yield* new HumanRequired({ plugin: name })
    const supervisor = yield* PluginSupervisor
    const plugin = yield* found(name)
    if (plugin.digest !== digest) {
      return yield* new DigestMismatch({ plugin: name, expected: digest, actual: plugin.digest })
    }
    if (plugin.trust !== "inert") return plugin
    // Checked again under the write permit, so a file change racing this call cannot be trusted.
    const enabled = yield* supervisor.update(
      name,
      (p) => p.digest === digest && p.trust === "inert" ? { ...p, trust: "enabled" } : undefined,
      yield* change(name, "enable", actor, digest)
    )
    if (Option.isNone(enabled)) {
      const now = yield* found(name)
      if (now.digest !== digest) return yield* new DigestMismatch({ plugin: name, expected: digest, actual: now.digest })
      return now
    }
    yield* supervisor.restart(name)
    return yield* stored(name)
  })

export const disablePlugin = (actor: Session.Actor, name: Ids.PluginName) =>
  Effect.gen(function*() {
    const supervisor = yield* PluginSupervisor
    const plugin = yield* found(name)
    if (plugin.trust === "inert") return plugin
    yield* supervisor.update(name, (p) => ({ ...p, trust: "inert" }), yield* change(name, "disable", actor))
    yield* supervisor.restart(name)
    return yield* stored(name)
  })

const secretFields = (plugin: Plugin.Plugin) =>
  (plugin.catalogue?.configuration ?? []).filter((field) => field._tag === "Secret").map((field) => field.key)

const forget = (plugin: Plugin.Plugin, kind: "remove" | "dev-unlink", actor: Session.Actor) =>
  Effect.gen(function*() {
    const supervisor = yield* PluginSupervisor
    yield* Effect.ignore((yield* SecretStore).delete(plugin.name, secretFields(plugin)))
    if (plugin.origin._tag !== "DevLink") {
      yield* Effect.ignore((yield* PluginDirectory).remove(plugin.name))
    }
    yield* supervisor.remove(
      plugin.name,
      yield* change(plugin.name, kind, actor),
      kind === "remove" ? "removed by you" : "unlinked by you"
    )
  })

/** Stops the plugin and deletes its files, record, configuration and secrets. Its change log stays. */
export const removePlugin = (actor: Session.Actor, name: Ids.PluginName) =>
  Effect.flatMap(found(name), (plugin) => forget(plugin, "remove", actor))

const validate = (name: Ids.PluginName, catalogue: Catalogue.Catalogue, values: Catalogue.ConfigurationValues) =>
  Effect.gen(function*() {
    for (const key of Object.keys(values)) {
      const field = catalogue.configuration.find((f) => f.key === key)
      if (field === undefined) return yield* new ConfigurationInvalid({ plugin: name, reason: `unknown field ${key}` })
      if (field._tag === "Choice" && !field.choices.includes(values[key]!)) {
        return yield* new ConfigurationInvalid({
          plugin: name,
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
export const configurePlugin = (actor: Session.Actor, name: Ids.PluginName, values: Catalogue.ConfigurationValues) =>
  Effect.gen(function*() {
    const supervisor = yield* PluginSupervisor
    const repository = yield* PluginRepository
    const secrets = yield* SecretStore
    const plugin = yield* found(name)
    const catalogue = plugin.catalogue
    if (catalogue === undefined) {
      return yield* new Refusal.PluginUnavailable({ plugin: name, problem: "it has not run yet, so its form is unknown" })
    }
    yield* validate(name, catalogue, values)
    const secretKeys = secretFields(plugin)
    const before = yield* repository.values(name)
    const after: Record<string, string> = { ...before }
    for (const [key, value] of Object.entries(values)) if (!secretKeys.includes(key)) after[key] = value
    const cleared = PluginRules.clearsSecrets(catalogue, before, after)
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
        plugin: name,
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
      return yield* new ConfigurationRejected({ plugin: name, reason: configuration.reason })
    }
    return yield* stored(name)
  })

/** Trusts a working directory as a dev plugin while linked and starts it. CLI only. */
export const devLink = (actor: Session.Actor, path: string) =>
  Effect.gen(function*() {
    const supervisor = yield* PluginSupervisor
    const installed = yield* Effect.mapError(
      (yield* PluginDirectory).read(path),
      (e) => new ImportFailed({ reason: e.reason })
    )
    const existing = yield* PluginRepository.use((r) => r.find(installed.name))
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
    yield* supervisor.restart(installed.name)
    return yield* stored(installed.name)
  })

export const devUnlink = (actor: Session.Actor, name: Ids.PluginName) =>
  Effect.gen(function*() {
    const plugin = yield* found(name)
    if (plugin.origin._tag !== "DevLink") return yield* new PluginNotFound({ plugin: name })
    yield* forget(plugin, "dev-unlink", actor)
  })

export const getSettings = SettingsStore.use((store) => store.read)

/** Writes the settings. A changed wake window reaches open Watch streams through a rewatch. */
export const setSettings = (settings: Settings.Settings) =>
  Effect.gen(function*() {
    yield* (yield* SettingsStore).write(settings)
    yield* (yield* PluginSupervisor).settingsChanged
    return settings
  })

/** Whether the daemon service runs and how it started; the caller adds its own version. */
export const serviceStatus = ServiceManager.use((manager) => manager.status)

/** The management group's use cases by contract method. None is offered to the agent group. */
export const management = {
  ImportPlugin: importPlugin,
  EnablePlugin: enablePlugin,
  DisablePlugin: disablePlugin,
  RemovePlugin: removePlugin,
  ConfigurePlugin: configurePlugin,
  DevLink: devLink,
  DevUnlink: devUnlink,
  ListPluginAlerts: listPluginAlerts,
  GetSettings: getSettings,
  SetSettings: setSettings,
  ServiceStatus: serviceStatus
} as const
