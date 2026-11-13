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
  /**
   * Reads, changes and writes the settings under one permit, so changes made at the same time do
   * not overwrite each other. Gives back what it wrote.
   */
  readonly update: <E, R>(
    change: (current: Settings.Settings) => Effect.Effect<Settings.Settings, E, R>
  ) => Effect.Effect<Settings.Settings, E | SettingsUnreadable | SettingsWriteFailed, R>
}>()("@exangelos/application/SettingsStore") {}
