import { Effect } from "effect"
import { Limits } from "@exangelos/domain"
import { SettingsStore } from "../ports/SettingsStore.ts"

/** The limits from the settings file, or the defaults while it cannot be read. */
export const currentLimits: Effect.Effect<Limits.Limits, never, SettingsStore> = Effect.gen(function*() {
  const store = yield* SettingsStore
  return yield* store.read.pipe(
    Effect.map((settings) => settings.limits),
    Effect.tapError((error) => Effect.logWarning("Settings unreadable, using default limits", error)),
    Effect.orElseSucceed(() => Limits.defaults)
  )
})
