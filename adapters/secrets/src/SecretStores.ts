import { Effect, FileSystem, Layer, Option, Path, Semaphore } from "effect"
import { ChildProcessSpawner } from "effect/process"
import { SecretStore } from "@exangelos/application"
import type { Ids } from "@exangelos/domain"
import { Keychain } from "@exangelos/keychain"
import { Paths } from "@exangelos/paths"
import * as SecretsFile from "./SecretsFile.ts"

const entry = (plugin: Ids.PluginName, field: string): Keychain.Entry => ({ service: `exangelos.${plugin}`, account: field })

const failed = (plugin: Ids.PluginName) => (error: { readonly reason: string }) =>
  new SecretStore.SecretStoreFailed({ plugin, reason: error.reason })

/** Keeps each secret field as one entry of the macOS Keychain or Secret Service, under service `exangelos.<plugin>`. */
export const layerKeychain: Layer.Layer<SecretStore.SecretStore, never, Keychain.Keychain> = Layer.effect(SecretStore.SecretStore)(
  Effect.gen(function*() {
    const keychain = yield* Keychain.Keychain
    return {
      set: (plugin, field, value) => keychain.set(entry(plugin, field), value).pipe(Effect.mapError(failed(plugin))),
      get: (plugin, field) => keychain.get(entry(plugin, field)).pipe(Effect.mapError(failed(plugin))),
      delete: (plugin, fields) =>
        Effect.forEach(fields, (field) => keychain.delete(entry(plugin, field)), { discard: true }).pipe(
          Effect.mapError(failed(plugin))
        )
    }
  })
)

/** Keeps every secret in one JSON file at mode 0600, for machines with no keychain. Writes in one process run one at a time. */
export const layerFile: Layer.Layer<SecretStore.SecretStore, never, FileSystem.FileSystem | Path.Path | Paths.Paths> =
  Layer.effect(SecretStore.SecretStore)(
    Effect.gen(function*() {
      const path = (yield* Paths.Paths).secretsFile
      const context = yield* Effect.context<FileSystem.FileSystem | Path.Path>()
      const writing = yield* Semaphore.make(1)
      return {
        set: (plugin, field, value) =>
          SecretsFile.set(path, plugin, field, value).pipe(
            writing.withPermit,
            Effect.mapError(failed(plugin)),
            Effect.provide(context)
          ),
        get: (plugin, field) => SecretsFile.get(path, plugin, field).pipe(Effect.mapError(failed(plugin)), Effect.provide(context)),
        delete: (plugin, fields) =>
          SecretsFile.remove(path, plugin, fields).pipe(
            writing.withPermit,
            Effect.mapError(failed(plugin)),
            Effect.provide(context)
          )
      }
    })
  )

type Chosen = Layer.Layer<
  SecretStore.SecretStore,
  never,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path | Paths.Paths
>

/**
 * Uses the macOS Keychain on macOS, Secret Service on Linux when `secret-tool` reaches one,
 * and otherwise the 0600 file the Paths service names. Logs which store it picked.
 */
export const layer = (platform: string): Chosen =>
  Layer.unwrap(
    Keychain.detect(platform).pipe(
      Effect.tap((store) => Effect.logInfo(`Secrets go to the ${Option.getOrElse(store, () => "fallback file")}`)),
      Effect.map((store): Chosen =>
        Option.isSome(store)
          ? layerKeychain.pipe(Layer.provide(Keychain.layer(store.value)))
          : layerFile
      )
    )
  )
