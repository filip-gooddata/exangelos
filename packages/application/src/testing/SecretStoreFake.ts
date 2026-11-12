import { Effect, Layer, Option, Ref } from "effect"
import type { Redacted } from "effect"
import type { Ids } from "@exangelos/domain"
import { SecretStore } from "../ports/SecretStore.ts"

const key = (plugin: Ids.PluginName, field: string) => `${plugin}\u0000${field}`

export const layerSecretStore: Layer.Layer<SecretStore> = Layer.unwrap(Effect.gen(function*() {
  const secrets = yield* Ref.make<ReadonlyMap<string, Redacted.Redacted<string>>>(new Map())
  return Layer.succeed(SecretStore, {
    set: (plugin, field, value) => Ref.update(secrets, (all) => new Map(all).set(key(plugin, field), value)),
    get: (plugin, field) => Effect.map(Ref.get(secrets), (all) => Option.fromNullishOr(all.get(key(plugin, field)))),
    delete: (plugin, fields) =>
      Ref.update(secrets, (all) => {
        const next = new Map(all)
        for (const field of fields) next.delete(key(plugin, field))
        return next
      })
  })
}))
