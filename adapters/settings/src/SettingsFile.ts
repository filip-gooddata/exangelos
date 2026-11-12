import { Effect, FileSystem, Layer, Path, Random, Schema } from "effect"
import { SettingsStore } from "@exangelos/application"
import { Settings } from "@exangelos/domain"
import { Paths } from "@exangelos/paths"

const Json = Schema.fromJsonString(Schema.Unknown)
const Record = Schema.Record(Schema.String, Schema.Unknown)

const initial = Schema.encodeSync(Settings.Settings)(Settings.initial)

const withDefaults = (file: unknown): unknown => {
  if (!Schema.is(Record)(file)) return file
  if (!("limits" in file)) return { ...initial, ...file }
  const limits = Schema.is(Record)(file.limits) ? { ...initial.limits, ...file.limits } : file.limits
  return { ...initial, ...file, limits }
}

const decode = (path: string, text: string) =>
  Schema.decodeEffect(Json)(text).pipe(
    Effect.map(withDefaults),
    Effect.flatMap(Schema.decodeUnknownEffect(Settings.Settings)),
    Effect.mapError((error) => new SettingsStore.SettingsUnreadable({ path, reason: error.message }))
  )

const read = (path: string) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const text = yield* fs.readFileString(path).pipe(
      Effect.catchIf(
        (error) => error.reason._tag === "NotFound",
        () => Effect.undefined
      ),
      Effect.mapError((error) => new SettingsStore.SettingsUnreadable({ path, reason: error.message }))
    )
    return text === undefined ? Settings.initial : yield* decode(path, text)
  })

const write = (path: string, settings: Settings.Settings) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const paths = yield* Path.Path
    const encoded = yield* Schema.encodeEffect(Settings.Settings)(settings)
    const temp = `${path}.${yield* Random.nextInt}.tmp`
    yield* fs.makeDirectory(paths.dirname(path), { recursive: true })
    yield* fs.writeFileString(temp, `${JSON.stringify(encoded, null, 2)}\n`)
    yield* fs.rename(temp, path)
  }).pipe(Effect.mapError((error) => new SettingsStore.SettingsWriteFailed({ path, reason: error.message })))

/** Reads and writes the settings file the Paths service names. */
export const layer: Layer.Layer<SettingsStore.SettingsStore, never, FileSystem.FileSystem | Path.Path | Paths.Paths> = Layer.effect(
  SettingsStore.SettingsStore
)(
  Effect.gen(function*() {
    const path = (yield* Paths.Paths).settingsFile
    const context = yield* Effect.context<FileSystem.FileSystem | Path.Path>()
    return {
      read: read(path).pipe(Effect.provide(context)),
      write: (settings) => write(path, settings).pipe(Effect.provide(context))
    }
  })
)
