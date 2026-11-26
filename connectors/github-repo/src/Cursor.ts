import { Option, Schema } from "effect"
import type { Memory } from "./Diff.ts"

const RefMemory = Schema.Struct({
  patterns: Schema.Array(Schema.String),
  refs: Schema.Record(Schema.String, Schema.String)
})
const Window = { seen: Schema.Array(Schema.String), floor: Schema.NullOr(Schema.String) }

const V1 = Schema.Struct({
  v: Schema.Literal(1),
  tags: Schema.NullOr(RefMemory),
  branches: Schema.NullOr(RefMemory),
  releases: Schema.NullOr(Schema.Struct({ patterns: Schema.Array(Schema.String), ...Window })),
  workflows: Schema.Record(Schema.String, Schema.Struct(Window))
})

const Encoded = Schema.fromJsonString(V1)

export const encode = (memory: Memory): string => Schema.encodeSync(Encoded)({ v: 1, ...memory })

/** The memory a cursor holds, or `undefined` for none or one this version cannot read, which starts a new baseline. */
export const decode = (cursor: string | undefined): Memory | undefined => {
  if (cursor === undefined) return undefined
  return Option.getOrUndefined(Option.map(Schema.decodeOption(Encoded)(cursor), ({ v: _, ...memory }) => memory))
}
