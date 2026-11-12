declare const EXANGELOS_VERSION: string | undefined
declare const EXANGELOS_OFFICIAL_PLUGINS: ReadonlyArray<{ name: string; version: string; digest: string }> | undefined

export const version: string = typeof EXANGELOS_VERSION === "string" ? EXANGELOS_VERSION : "0.0.0-dev"

export const officialPlugins: ReadonlyArray<{ name: string; version: string; digest: string }> =
  typeof EXANGELOS_OFFICIAL_PLUGINS === "object" ? EXANGELOS_OFFICIAL_PLUGINS : []
