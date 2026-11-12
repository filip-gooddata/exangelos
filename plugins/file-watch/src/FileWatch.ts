import { homedir } from "node:os"
import { Clock, DateTime, Duration, Effect, FileSystem, Option, Result, Schema, Stream } from "effect"
import { Catalogue, Plugin } from "@exangelos/plugin-sdk"
import type { Change } from "./Baseline.ts"
import * as FileGlob from "./FileGlob.ts"
import * as Watcher from "./Watcher.ts"

const Present = Schema.Struct({
  path: Schema.String,
  size: Schema.Finite,
  modifiedAt: Schema.String
})

export const created = Catalogue.event("file.created", {
  description: "A file matching the glob appeared",
  payload: Present
})

export const changed = Catalogue.event("file.changed", {
  description: "A file matching the glob changed its contents or size",
  payload: Present
})

export const deleted = Catalogue.event("file.deleted", {
  description: "A file matching the glob disappeared",
  payload: Schema.Struct({ path: Schema.String })
})

const parameters = Catalogue.parameters({
  main: "path",
  schema: Schema.Struct({
    path: Schema.String.annotate({ description: "Path glob such as ~/code/api-gateway/dist/**" }),
    ignore: Schema.optionalKey(
      Schema.Array(Schema.String).annotate({ description: "Globs to ignore, relative to the watched directory or absolute" })
    )
  })
})

type Parameters = typeof parameters.schema.Type

export interface Options {
  /**
   * How long notices for one file gather into one event. The protocol does
   * not pass the daemon's wake window, so the default matches its default.
   */
  readonly settle?: Duration.Duration
  readonly home?: string
}

const verbs = { "file.created": "Created", "file.changed": "Changed", "file.deleted": "Deleted" } as const

const item = (glob: FileGlob.FileGlob, home: string, change: Change, now: number, cursor?: string) => {
  const path = glob.base === "/" ? `/${change.path}` : `${glob.base}/${change.path}`
  const summary = `${verbs[change.type]} ${FileGlob.display(path, home)}`
  const tail = cursor === undefined ? {} : { cursor }
  if (change.type === "file.deleted") {
    return deleted.item({
      occurredAt: DateTime.makeUnsafe(now),
      summary,
      payload: { path },
      dedupeKey: `file.deleted:${path}:${change.lastModifiedAt}`,
      ...tail
    })
  }
  const event = change.type === "file.created" ? created : changed
  return event.item({
    occurredAt: DateTime.makeUnsafe(change.file.modifiedAt),
    summary,
    payload: { path, size: change.file.size, modifiedAt: new Date(change.file.modifiedAt).toISOString() },
    dedupeKey: `${change.type}:${path}:${change.file.modifiedAt}:${change.file.size}`,
    ...tail
  })
}

const toItems = (glob: FileGlob.FileGlob, home: string) => (batch: Watcher.Batch) =>
  Effect.map(Clock.currentTimeMillis, (now) => {
    if (batch.changes.length === 0) return [Plugin.cursor(batch.cursor)]
    const last = batch.changes.length - 1
    return batch.changes.map((change, index) => item(glob, home, change, now, index === last ? batch.cursor : undefined))
  })

/** Builds the plugin. Tests pass a short settle interval. */
export const make = (options: Options = {}) =>
  Plugin.make({
    events: [created, changed, deleted],
    parameters,
    configuration: [],
    handlers: Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const home = options.home ?? homedir()
      const settle = options.settle ?? Duration.seconds(5)
      return {
        configure: () => Effect.void,
        describe: (input: Parameters) =>
          Effect.gen(function*() {
            const glob = FileGlob.parse(input, home)
            if (Result.isFailure(glob)) return yield* new Plugin.ParametersInvalid({ reason: glob.failure })
            const base = yield* fs.stat(glob.success.base).pipe(Effect.option)
            if (Option.isSome(base) && base.value.type !== "Directory") {
              return yield* new Plugin.ParametersInvalid({ reason: `${glob.success.base} is not a directory` })
            }
            const ignore = [...new Set((input.ignore ?? []).map((pattern) => pattern.trim()).filter((pattern) => pattern !== ""))]
              .sort()
            return {
              subject: glob.success.glob,
              label: FileGlob.display(glob.success.glob, home),
              parameters: { path: glob.success.glob, ...(ignore.length === 0 ? {} : { ignore }) }
            }
          }),
        watch: ({ parameters, cursor }) => {
          const glob = FileGlob.parse(parameters, home)
          if (Result.isFailure(glob)) return Stream.fail(new Plugin.SourceFailed({ reason: glob.failure }))
          return Watcher.watch(glob.success, cursor, { settle }).pipe(
            Stream.mapEffect(toItems(glob.success, home)),
            Stream.flattenIterable,
            Stream.provideService(FileSystem.FileSystem, fs)
          )
        }
      }
    })
  })

export const plugin = make()
