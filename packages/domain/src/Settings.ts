import { Schema } from "effect"
import { defaults, Limits } from "./Limits.ts"

export const Settings = Schema.Struct({
  eventAlerts: Schema.Boolean,
  limits: Limits,
  officialPluginFolder: Schema.optionalKey(Schema.String)
})
export type Settings = typeof Settings.Type

export const initial: Settings = { eventAlerts: false, limits: defaults }
