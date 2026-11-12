import { Effect, FileSystem, Layer, Option, Path } from "effect"
import { ChildProcessSpawner } from "effect/process"
import { SecretStore } from "@exangelos/application"
import type { Ids } from "@exangelos/domain"
import { Keychain } from "@exangelos/keychain"
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

/** Keeps every secret in one JSON file at mode 0600, for machines with no keychain. */
export const layerFile = (path: string): Layer.Layer<SecretStore.SecretStore, never, FileSystem.FileSystem | Path.Path> =>
  Layer.effect(SecretStore.SecretStore)(
    Effect.gen(function*() {
      const context = yield* Effect.context<FileSystem.FileSystem | Path.Path>()
      return {
        set: (plugin, field, value) =>
          SecretsFile.set(path, plugin, field, value).pipe(Effect.mapError(failed(plugin)), Effect.provide(context)),
        get: (plugin, field) => SecretsFile.get(path, plugin, field).pipe(Effect.mapError(failed(plugin)), Effect.provide(context)),
        delete: (plugin, fields) =>
          SecretsFile.remove(path, plugin, fields).pipe(Effect.mapError(failed(plugin)), Effect.provide(context))
      }
    })
  )

type Chosen = Layer.Layer<
  SecretStore.SecretStore,
  never,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
>

/**
 * Uses the macOS Keychain on macOS, Secret Service on Linux when `secret-tool` reaches one,
 * and otherwise the 0600 file at `file`.
 */
export const layer = (options: { readonly platform: string; readonly file: string }): Chosen =>
  Layer.unwrap(
    Keychain.detect(options.platform).pipe(
      Effect.map((store): Chosen =>
        Option.isSome(store)
          ? layerKeychain.pipe(Layer.provide(Keychain.layer(store.value)))
          : layerFile(options.file)
      )
    )
  )
