import { Effect, Layer, Ref, Semaphore } from "effect"
import { Settings } from "@exangelos/domain"
import { SettingsStore } from "../ports/SettingsStore.ts"

export const layerSettingsStore = (initial: Settings.Settings = Settings.initial): Layer.Layer<SettingsStore> =>
  Layer.unwrap(Effect.gen(function*() {
    const settings = yield* Ref.make(initial)
    const permit = yield* Semaphore.make(1)
    return Layer.succeed(SettingsStore, {
      read: Ref.get(settings),
      write: (next) => Ref.set(settings, next),
      update: (change) =>
        Semaphore.withPermit(permit)(Effect.gen(function*() {
          const next = yield* change(yield* Ref.get(settings))
          yield* Ref.set(settings, next)
          return next
        }))
    })
  }))
