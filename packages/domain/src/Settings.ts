import { Schema } from "effect"
import { Definition } from "./CommandHarness.ts"
import { defaults, Limits } from "./Limits.ts"
import { HarnessName } from "./Session.ts"

export const Settings = Schema.Struct({
  eventAlerts: Schema.Boolean,
  limits: Limits,
  officialConnectorFolder: Schema.optionalKey(Schema.String),
  /** The harnesses you define, by name. Only you change them, and not through `SetSettings`. */
  harnesses: Schema.Record(HarnessName, Definition)
})
export type Settings = typeof Settings.Type

export const initial: Settings = { eventAlerts: false, limits: defaults, harnesses: {} }
