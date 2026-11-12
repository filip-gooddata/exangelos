import { Context, Schema } from "effect"
import type { Effect } from "effect"
import type { Settings } from "@exangelos/domain"

export class SettingsUnreadable extends Schema.TaggedError<SettingsUnreadable>()("SettingsUnreadable", {
  path: Schema.String,
  reason: Schema.String
}) {}

export class SettingsWriteFailed extends Schema.TaggedError<SettingsWriteFailed>()("SettingsWriteFailed", {
  path: Schema.String,
  reason: Schema.String
}) {}

export class SettingsStore extends Context.Service<SettingsStore, {
  /** The settings file, or the initial settings when there is none. */
  readonly read: Effect.Effect<Settings.Settings, SettingsUnreadable>
  readonly write: (settings: Settings.Settings) => Effect.Effect<void, SettingsWriteFailed>
}>()("@exangelos/application/SettingsStore") {}
