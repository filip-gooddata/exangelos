import { Effect, Layer, Ref } from "effect"
import type { Catalogue, Ids } from "@exangelos/domain"
import { SecretStore } from "../ports/SecretStore.ts"

export const layerSecretStore: Layer.Layer<SecretStore> = Layer.unwrap(Effect.gen(function*() {
  const secrets = yield* Ref.make<ReadonlyMap<Ids.PluginName, Catalogue.ConfigurationValues>>(new Map())
  return Layer.succeed(SecretStore, {
    read: (plugin) => Effect.map(Ref.get(secrets), (all) => all.get(plugin) ?? {}),
    write: (plugin, values) => Ref.update(secrets, (all) => new Map(all).set(plugin, values)),
    clear: (plugin) =>
      Ref.update(secrets, (all) => {
        const next = new Map(all)
        next.delete(plugin)
        return next
      })
  })
}))
