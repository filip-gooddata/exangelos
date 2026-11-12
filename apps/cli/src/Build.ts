declare const EXANGELOS_VERSION: string | undefined
declare const EXANGELOS_OFFICIAL_PLUGINS: ReadonlyArray<{ name: string; version: string; digest: string }> | undefined

export const version: string = typeof EXANGELOS_VERSION === "string" ? EXANGELOS_VERSION : "0.0.0-dev"

export const officialPlugins: ReadonlyArray<{ name: string; version: string; digest: string }> =
  typeof EXANGELOS_OFFICIAL_PLUGINS === "object" ? EXANGELOS_OFFICIAL_PLUGINS : []

declare const EXANGELOS_PLUGIN_TEMPLATE: Readonly<Record<string, string>> | undefined

export const pluginTemplate: Readonly<Record<string, string>> | undefined = typeof EXANGELOS_PLUGIN_TEMPLATE === "object"
  ? EXANGELOS_PLUGIN_TEMPLATE
  : undefined
