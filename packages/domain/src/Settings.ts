import { Schema } from "effect"
import { Definition } from "./CommandHarness.ts"
import { defaults, Limits } from "./Limits.ts"
import { HarnessName } from "./Session.ts"

export const LogLevel = Schema.Literals(["error", "warn", "info", "debug", "trace"])
export type LogLevel = typeof LogLevel.Type

export const Settings = Schema.Struct({
  eventAlerts: Schema.Boolean,
  limits: Limits,
  officialConnectorFolder: Schema.optionalKey(Schema.String),
  harnesses: Schema.Record(HarnessName, Definition),
  logLevel: Schema.optionalKey(LogLevel)
})
export type Settings = typeof Settings.Type

export const initial: Settings = { eventAlerts: false, limits: defaults, harnesses: {} }
