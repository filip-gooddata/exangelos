import { Context, Schema } from "effect"
import type { Effect } from "effect"
import type { Settings } from "@exangelos/domain"

export class SettingsFailed extends Schema.TaggedError<SettingsFailed>()("SettingsFailed", {
  reason: Schema.String
}) {}

export class SettingsStore extends Context.Service<SettingsStore, {
  /** The settings file, or the initial settings when there is none. */
  readonly read: Effect.Effect<Settings.Settings, SettingsFailed>
  readonly write: (settings: Settings.Settings) => Effect.Effect<void, SettingsFailed>
}>()("@exangelos/application/SettingsStore") {}
