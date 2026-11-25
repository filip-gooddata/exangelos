declare const EXANGELOS_VERSION: string | undefined
declare const EXANGELOS_OFFICIAL_CONNECTORS: ReadonlyArray<{ name: string; version: string; digest: string }> | undefined

export const version: string = typeof EXANGELOS_VERSION === "string" ? EXANGELOS_VERSION : "0.0.0-dev"

export const officialConnectors: ReadonlyArray<{ name: string; version: string; digest: string }> =
  typeof EXANGELOS_OFFICIAL_CONNECTORS === "object" ? EXANGELOS_OFFICIAL_CONNECTORS : []

declare const EXANGELOS_RELEASE_URL: string | undefined

export const releaseUrl: string | undefined = typeof EXANGELOS_RELEASE_URL === "string" ? EXANGELOS_RELEASE_URL : undefined

declare const EXANGELOS_CONNECTOR_TEMPLATE: Readonly<Record<string, string>> | undefined

export const connectorTemplate: Readonly<Record<string, string>> | undefined = typeof EXANGELOS_CONNECTOR_TEMPLATE === "object"
  ? EXANGELOS_CONNECTOR_TEMPLATE
  : undefined

declare const EXANGELOS_SKILL: string | undefined

export const skill: string | undefined = typeof EXANGELOS_SKILL === "string" ? EXANGELOS_SKILL : undefined
