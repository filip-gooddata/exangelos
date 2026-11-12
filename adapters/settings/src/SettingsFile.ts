import { Effect, FileSystem, Path, Random, Schema } from "effect"
import { Settings } from "@exangelos/domain"

export class SettingsFileUnreadable extends Schema.TaggedError<SettingsFileUnreadable>()("SettingsFileUnreadable", {
  path: Schema.String,
  reason: Schema.String
}) {}

export class SettingsFileWriteFailed extends Schema.TaggedError<SettingsFileWriteFailed>()("SettingsFileWriteFailed", {
  path: Schema.String,
  reason: Schema.String
}) {}

const Json = Schema.fromJsonString(Schema.Unknown)
const Record = Schema.Record(Schema.String, Schema.Unknown)

const initial = Schema.encodeSync(Settings.Settings)(Settings.initial)

const withDefaults = (file: unknown): unknown => {
  if (!Schema.is(Record)(file)) return file
  const limits = Schema.is(Record)(file.limits) ? { ...initial.limits, ...file.limits } : file.limits ?? initial.limits
  return { ...initial, ...file, limits }
}

const decode = (path: string, text: string) =>
  Schema.decodeEffect(Json)(text).pipe(
    Effect.map(withDefaults),
    Effect.flatMap(Schema.decodeUnknownEffect(Settings.Settings)),
    Effect.mapError((error) => new SettingsFileUnreadable({ path, reason: error.message }))
  )

export const read = (path: string) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const text = yield* fs.readFileString(path).pipe(
      Effect.catchIf(
        (error) => error.reason._tag === "NotFound",
        () => Effect.undefined
      ),
      Effect.mapError((error) => new SettingsFileUnreadable({ path, reason: error.message }))
    )
    return text === undefined ? Settings.initial : yield* decode(path, text)
  })

export const write = (path: string, settings: Settings.Settings) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const paths = yield* Path.Path
    const encoded = yield* Schema.encodeEffect(Settings.Settings)(settings)
    const temp = `${path}.${yield* Random.nextInt}.tmp`
    yield* fs.makeDirectory(paths.dirname(path), { recursive: true })
    yield* fs.writeFileString(temp, `${JSON.stringify(encoded, null, 2)}\n`)
    yield* fs.rename(temp, path)
  }).pipe(Effect.mapError((error) => new SettingsFileWriteFailed({ path, reason: error.message })))
