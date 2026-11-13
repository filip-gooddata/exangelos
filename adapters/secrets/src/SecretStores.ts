import { Effect, FileSystem, Layer, Option, Path, Semaphore } from "effect"
import { ChildProcessSpawner } from "effect/process"
import { SecretStore } from "@exangelos/application"
import type { Ids } from "@exangelos/domain"
import { Keychain } from "@exangelos/keychain"
import { Paths } from "@exangelos/paths"
import * as SecretsFile from "./SecretsFile.ts"

const entry = (connector: Ids.ConnectorName, field: string): Keychain.Entry => ({ service: `exangelos.${connector}`, account: field })

const failed = (connector: Ids.ConnectorName) => (error: { readonly reason: string }) =>
  new SecretStore.SecretStoreFailed({ connector, reason: error.reason })

/** Keeps each secret field as one entry of the macOS Keychain or Secret Service, under service `exangelos.<connector>`. */
export const layerKeychain: Layer.Layer<SecretStore.SecretStore, never, Keychain.Keychain> = Layer.effect(SecretStore.SecretStore)(
  Effect.gen(function*() {
    const keychain = yield* Keychain.Keychain
    return {
      set: (connector, field, value) => keychain.set(entry(connector, field), value).pipe(Effect.mapError(failed(connector))),
      get: (connector, field) => keychain.get(entry(connector, field)).pipe(Effect.mapError(failed(connector))),
      delete: (connector, fields) =>
        Effect.forEach(fields, (field) => keychain.delete(entry(connector, field)), { discard: true }).pipe(
          Effect.mapError(failed(connector))
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
        set: (connector, field, value) =>
          SecretsFile.set(path, connector, field, value).pipe(
            writing.withPermit,
            Effect.mapError(failed(connector)),
            Effect.provide(context)
          ),
        get: (connector, field) => SecretsFile.get(path, connector, field).pipe(Effect.mapError(failed(connector)), Effect.provide(context)),
        delete: (connector, fields) =>
          SecretsFile.remove(path, connector, fields).pipe(
            writing.withPermit,
            Effect.mapError(failed(connector)),
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
