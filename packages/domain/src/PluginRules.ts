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

export interface FilesChanged {
  readonly plugin: Plugin
  readonly restart: boolean
}

export const filesChanged = (plugin: Plugin, digest: string, officialChecksum: Option.Option<string>): FilesChanged => {
  const trust = initialTrust(plugin.origin, digest, officialChecksum)
  const restart = trust !== "inert"
  return {
    plugin: { ...plugin, digest, trust, process: restart ? plugin.process : "stopped" },
    restart
  }
}

export const alerts = (before: Option.Option<Plugin>, after: Plugin): ReadonlyArray<Alert> => {
  const was = Option.getOrUndefined(before)
  const result: Array<Alert> = []
  if (after.trust === "inert" && was?.trust !== "inert") {
    result.push(
      after.origin._tag === "Official"
        ? { _tag: "ChecksumMismatch", plugin: after.name }
        : { _tag: "WaitingToBeEnabled", plugin: after.name }
    )
  }
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
