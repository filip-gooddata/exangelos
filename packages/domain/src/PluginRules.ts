import { type DateTime, Option } from "effect"
import type { Alert } from "./Alert.ts"
import type { Catalogue, ConfigurationValues } from "./Catalogue.ts"
import type { Configuration, Origin, Plugin, Trust } from "./Plugin.ts"

export const isAvailable = (plugin: Plugin): boolean => Option.isNone(problem(plugin))

export const problem = (plugin: Plugin): Option.Option<string> => {
  if (plugin.trust === "inert") return Option.some("it waits to be enabled")
  if (plugin.configuration._tag === "Missing") return Option.some("its configuration is missing")
  if (plugin.configuration._tag === "Rejected") {
    return Option.some(`its configuration was rejected: ${plugin.configuration.reason}`)
  }
  if (plugin.process === "failing") return Option.some("it keeps failing")
  if (plugin.process !== "running") return Option.some(`its process is ${plugin.process}`)
  return Option.none()
}

export const trackAvailability = (plugin: Plugin, now: DateTime.Utc): Plugin => {
  if (isAvailable(plugin)) {
    const { unavailableSince: _, ...rest } = plugin
    return rest
  }
  return plugin.unavailableSince === undefined ? { ...plugin, unavailableSince: now } : plugin
}

export const initialTrust = (origin: Origin, digest: string, officialChecksum: Option.Option<string>): Trust => {
  switch (origin._tag) {
    case "DevLink":
      return "dev"
    case "Official":
      return Option.contains(officialChecksum, digest) ? "enabled" : "inert"
    default:
      return "inert"
  }
}

export const trustAlert = (plugin: Plugin, officialChecksum: Option.Option<string>): Option.Option<Alert> => {
  if (plugin.trust !== "inert") return Option.none()
  if (plugin.origin._tag !== "Official") return Option.some({ _tag: "WaitingToBeEnabled", plugin: plugin.name })
  return Option.contains(officialChecksum, plugin.digest)
    ? Option.none()
    : Option.some({ _tag: "ChecksumMismatch", plugin: plugin.name })
}

export interface FilesChanged {
  readonly plugin: Plugin
  readonly restart: boolean
  readonly alert: Option.Option<Alert>
}

export const filesChanged = (plugin: Plugin, digest: string, officialChecksum: Option.Option<string>): FilesChanged => {
  const trust = plugin.trust === "enabled" ? initialTrust(plugin.origin, digest, officialChecksum) : plugin.trust
  const restart = trust !== "inert"
  const changed: Plugin = { ...plugin, digest, trust, process: restart ? plugin.process : "stopped" }
  return {
    plugin: changed,
    restart,
    alert: plugin.trust === "inert" ? Option.none() : trustAlert(changed, officialChecksum)
  }
}

export const alerts = (before: Option.Option<Plugin>, after: Plugin): ReadonlyArray<Alert> => {
  const was = Option.getOrUndefined(before)
  const result: Array<Alert> = []
  if (after.process === "failing" && was?.process !== "failing") {
    result.push({ _tag: "KeepsFailing", plugin: after.name })
  }
  if (after.configuration._tag === "Rejected" && was?.configuration._tag !== "Rejected") {
    result.push({ _tag: "CredentialsRejected", plugin: after.name, reason: after.configuration.reason })
  }
  return result
}

export const configuration = (
  catalogue: Catalogue,
  values: ConfigurationValues,
  storedSecrets: ReadonlyArray<string>
): Configuration => {
  const complete = catalogue.configuration.every((field) =>
    !field.required || (field._tag === "Secret" ? storedSecrets.includes(field.key) : values[field.key] !== undefined)
  )
  return complete ? { _tag: "Set" } : { _tag: "Missing" }
}

export const clearsSecrets = (
  catalogue: Catalogue,
  before: ConfigurationValues,
  after: ConfigurationValues
): boolean =>
  catalogue.configuration.some((field) =>
    field._tag !== "Secret" && field.secretDestination && before[field.key] !== after[field.key]
  )
