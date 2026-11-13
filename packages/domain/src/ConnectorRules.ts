import { type DateTime, Option } from "effect"
import type { Alert } from "./Alert.ts"
import type { Catalogue, ConfigurationValues } from "./Catalogue.ts"
import type { Configuration, Origin, Connector, Trust } from "./Connector.ts"

export const isAvailable = (connector: Connector): boolean => Option.isNone(problem(connector))

export const problem = (connector: Connector): Option.Option<string> => {
  if (connector.trust === "inert") return Option.some("it waits to be enabled")
  if (connector.configuration._tag === "Missing") return Option.some("its configuration is missing")
  if (connector.configuration._tag === "Rejected") {
    return Option.some(`its configuration was rejected: ${connector.configuration.reason}`)
  }
  if (connector.process === "failing") return Option.some("it keeps failing")
  if (connector.process !== "running") return Option.some(`its process is ${connector.process}`)
  return Option.none()
}

export const trackAvailability = (connector: Connector, now: DateTime.Utc): Connector => {
  if (isAvailable(connector)) {
    const { unavailableSince: _, ...rest } = connector
    return rest
  }
  return connector.unavailableSince === undefined ? { ...connector, unavailableSince: now } : connector
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

export const trustAlert = (connector: Connector, officialChecksum: Option.Option<string>): Option.Option<Alert> => {
  if (connector.trust !== "inert") return Option.none()
  if (connector.origin._tag !== "Official") return Option.some({ _tag: "WaitsForEnable", connector: connector.name })
  return Option.contains(officialChecksum, connector.digest)
    ? Option.none()
    : Option.some({ _tag: "DigestMismatch", connector: connector.name })
}

export interface FilesChanged {
  readonly connector: Connector
  readonly restart: boolean
  readonly alert: Option.Option<Alert>
}

export const filesChanged = (connector: Connector, digest: string): FilesChanged => {
  if (connector.trust === "dev") return { connector: { ...connector, digest }, restart: true, alert: Option.none() }
  const alert: Option.Option<Alert> = connector.trust === "inert"
    ? Option.none()
    : Option.some(
      connector.origin._tag === "Official"
        ? { _tag: "DigestMismatch", connector: connector.name }
        : { _tag: "WaitsForEnable", connector: connector.name }
    )
  return { connector: { ...connector, digest, trust: "inert", process: "stopped" }, restart: false, alert }
}

export const alerts = (before: Option.Option<Connector>, after: Connector): ReadonlyArray<Alert> => {
  const was = Option.getOrUndefined(before)
  const result: Array<Alert> = []
  if (after.process === "failing" && was?.process !== "failing") {
    result.push({ _tag: "Failing", connector: after.name, reason: "it keeps failing" })
  }
  if (after.configuration._tag === "Rejected" && was?.configuration._tag !== "Rejected") {
    result.push({ _tag: "CredentialsRejected", connector: after.name, reason: after.configuration.reason })
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
