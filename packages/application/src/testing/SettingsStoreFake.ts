import { Effect, Layer, Ref } from "effect"
import { Settings } from "@exangelos/domain"
import { SettingsStore } from "../ports/SettingsStore.ts"

export const layerSettingsStore = (initial: Settings.Settings = Settings.initial): Layer.Layer<SettingsStore> =>
  Layer.unwrap(Effect.map(Ref.make(initial), (settings) =>
    Layer.succeed(SettingsStore, {
      read: Ref.get(settings),
      write: (next) => Ref.set(settings, next)
    })))
