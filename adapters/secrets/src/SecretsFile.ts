import { Effect, FileSystem, Option, Path, Random, Redacted, Schema } from "effect"

export class SecretsFileFailed extends Schema.TaggedError<SecretsFileFailed>()("SecretsFileFailed", {
  path: Schema.String,
  reason: Schema.String
}) {}

const Contents = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.String)))
type Contents = typeof Contents.Type

const load = (path: string) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const text = yield* fs.readFileString(path).pipe(
      Effect.catchIf(
        (error) => error.reason._tag === "NotFound",
        () => Effect.undefined
      ),
      Effect.mapError((error) => new SecretsFileFailed({ path, reason: error.message }))
    )
    if (text === undefined) return {} as Contents
    return yield* Schema.decodeEffect(Contents)(text).pipe(
      Effect.mapError(() => new SecretsFileFailed({ path, reason: "the file does not hold a JSON object of plugins and fields" }))
    )
  })

const save = (path: string, contents: Contents) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const paths = yield* Path.Path
    const temp = `${path}.${yield* Random.nextInt}.tmp`
    yield* fs.makeDirectory(paths.dirname(path), { recursive: true, mode: 0o700 })
    yield* fs.writeFileString(temp, "", { flag: "wx", mode: 0o600 })
    yield* Effect.gen(function*() {
      yield* fs.chmod(temp, 0o600)
      yield* fs.writeFileString(temp, JSON.stringify(contents), { flag: "w" })
      yield* fs.rename(temp, path)
    }).pipe(Effect.onError(() => fs.remove(temp).pipe(Effect.ignore)))
  }).pipe(Effect.mapError((error) => new SecretsFileFailed({ path, reason: error.message })))

const own = <A>(record: Readonly<Record<string, A>> | undefined, key: string): A | undefined =>
  record !== undefined && Object.hasOwn(record, key) ? record[key] : undefined

export const get = (path: string, plugin: string, field: string) =>
  load(path).pipe(
    Effect.map((contents) => Option.fromNullishOr(own(own(contents, plugin), field)).pipe(Option.map(Redacted.make)))
  )

export const set = (path: string, plugin: string, field: string, value: Redacted.Redacted<string>) =>
  Effect.gen(function*() {
    const contents = yield* load(path)
    yield* save(path, { ...contents, [plugin]: { ...own(contents, plugin), [field]: Redacted.value(value) } })
  })

export const remove = (path: string, plugin: string, fields: ReadonlyArray<string>) =>
  Effect.gen(function*() {
    const contents = yield* load(path)
    const current = own(contents, plugin)
    if (current === undefined || !fields.some((field) => Object.hasOwn(current, field))) return
    const kept = Object.fromEntries(Object.entries(current).filter(([field]) => !fields.includes(field)))
    const { [plugin]: _, ...others } = contents
    yield* save(path, Object.keys(kept).length === 0 ? others : { ...others, [plugin]: kept })
  })
