import { Option, Schema } from "effect"
import type { Mark, Memory } from "./Diff.ts"

const MarkSchema = Schema.Struct({ at: Schema.NullOr(Schema.String), ids: Schema.Array(Schema.String) })

const Common = {
  head: Schema.String,
  base: Schema.Struct({ name: Schema.String, oid: Schema.String }),
  conflictReported: Schema.Boolean,
  failedReported: Schema.Array(Schema.String),
  passedReported: Schema.Boolean,
  readyReported: Schema.Boolean,
  reviews: MarkSchema,
  comments: MarkSchema,
  threads: MarkSchema
}

const V1 = Schema.Struct({ v: Schema.Literal(1), ...Common })

const V2 = Schema.Struct({
  v: Schema.Literal(2),
  ...Common,
  replies: MarkSchema,
  requests: MarkSchema,
  draft: Schema.NullOr(Schema.Struct({ isDraft: Schema.Boolean, changes: Schema.Int })),
  checkPassed: Schema.Array(Schema.String),
  pin: Schema.NullOr(Schema.Struct({ param: Schema.String, oid: Schema.String })),
  reviewer: Schema.NullOr(Schema.Struct({ login: Schema.String, reviewedAt: Schema.NullOr(Schema.String) }))
})

const Encoded = Schema.fromJsonString(V2)
const Any = Schema.fromJsonString(Schema.Union([V2, V1]))

/**
 * A v1 cursor never saw replies or review requests. Their marks start at the newest activity v1 recorded, which is
 * no later than its last poll, so replies and requests made since then are still reported; earlier ones may be too,
 * and their dedupe keys keep them from repeating.
 */
const fromV1 = ({ v: _, ...memory }: typeof V1.Type): Memory => {
  const times = [memory.reviews.at, memory.comments.at, memory.threads.at].filter((t): t is string => t !== null)
  const since: Mark = { at: times.length === 0 ? null : times.reduce((a, b) => (a > b ? a : b)), ids: [] }
  return { ...memory, replies: since, requests: since, draft: null, checkPassed: [], pin: null, reviewer: null }
}

export const encode = (memory: Memory): string => Schema.encodeSync(Encoded)({ v: 2, ...memory })

export const decode = (cursor: string | undefined): Memory | undefined => {
  if (cursor === undefined) return undefined
  return Option.getOrUndefined(
    Option.map(Schema.decodeOption(Any)(cursor), (decoded) => {
      if (decoded.v === 1) return fromV1(decoded)
      const { v: _, ...memory } = decoded
      return memory
    })
  )
}
