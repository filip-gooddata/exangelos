import { Option, Schema } from "effect"
import type { Memory } from "./Diff.ts"

const Mark = Schema.Struct({ at: Schema.NullOr(Schema.String), ids: Schema.Array(Schema.String) })

/**
 * Version 1 of the cursor: the diff's memory as JSON. A cursor in a version
 * this plugin does not know reads as none, so the next poll is a new baseline.
 */
const V1 = Schema.Struct({
  v: Schema.Literal(1),
  head: Schema.String,
  base: Schema.Struct({ name: Schema.String, oid: Schema.String }),
  conflictReported: Schema.Boolean,
  failedReported: Schema.Array(Schema.String),
  passedReported: Schema.Boolean,
  readyReported: Schema.Boolean,
  reviews: Mark,
  comments: Mark,
  threads: Mark
})

const Json = Schema.fromJsonString(V1)

export const encode = (memory: Memory): string => Schema.encodeSync(Json)({ v: 1, ...memory })

export const decode = (cursor: string | undefined): Memory | undefined => {
  if (cursor === undefined) return undefined
  return Option.getOrUndefined(
    Option.map(Schema.decodeOption(Json)(cursor), ({ v: _, ...memory }) => memory)
  )
}
