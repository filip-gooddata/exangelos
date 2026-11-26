import { Option, Schema } from "effect"
import type { Memory, RefMemory } from "./Diff.ts"

const Pairs = Schema.Array(Schema.Tuple([Schema.String, Schema.String]))

const Refs = Schema.Struct({ patterns: Schema.Array(Schema.String), refs: Pairs })

const Run = Schema.Struct({ id: Schema.Finite, attempt: Schema.Finite, completed: Schema.Boolean })

const V1 = Schema.Struct({
  v: Schema.Literal(1),
  tags: Schema.NullOr(Refs),
  branches: Schema.NullOr(Refs),
  releases: Schema.NullOr(Schema.Struct({
    patterns: Schema.Array(Schema.String),
    since: Schema.String,
    ids: Schema.Array(Schema.Finite)
  })),
  workflows: Schema.Array(Schema.Tuple([
    Schema.String,
    Schema.Struct({ newest: Schema.Finite, runs: Schema.Array(Run) })
  ]))
})

const Encoded = Schema.fromJsonString(V1)

const refsOut = (refs: RefMemory | null) => refs === null ? null : { patterns: refs.patterns, refs: [...refs.refs] }

const refsIn = (refs: typeof Refs.Type | null): RefMemory | null =>
  refs === null ? null : { patterns: refs.patterns, refs: new Map(refs.refs) }

export const encode = (memory: Memory): string =>
  Schema.encodeSync(Encoded)({
    v: 1,
    tags: refsOut(memory.tags),
    branches: refsOut(memory.branches),
    releases: memory.releases,
    workflows: [...memory.workflows]
  })

/** The memory a cursor holds, or `undefined` for none or one this version cannot read, which starts a new baseline. */
export const decode = (cursor: string | undefined): Memory | undefined => {
  if (cursor === undefined) return undefined
  return Option.getOrUndefined(Option.map(Schema.decodeOption(Encoded)(cursor), (decoded) => ({
    tags: refsIn(decoded.tags),
    branches: refsIn(decoded.branches),
    releases: decoded.releases,
    workflows: new Map(decoded.workflows)
  })))
}
