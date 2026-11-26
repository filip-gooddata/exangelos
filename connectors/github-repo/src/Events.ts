import { Schema } from "effect"

const Run = {
  workflow: Schema.String,
  name: Schema.String,
  runId: Schema.Finite,
  attempt: Schema.Finite,
  runNumber: Schema.Finite,
  branch: Schema.NullOr(Schema.String),
  sha: Schema.String,
  event: Schema.String,
  url: Schema.String
}

export const payloads = {
  "tag.created": Schema.Struct({ name: Schema.String, sha: Schema.String }),
  "tag.moved": Schema.Struct({ name: Schema.String, sha: Schema.String, previous: Schema.String }),
  "branch.created": Schema.Struct({ name: Schema.String, sha: Schema.String }),
  "branch.moved": Schema.Struct({ name: Schema.String, sha: Schema.String, previous: Schema.String }),
  "branch.deleted": Schema.Struct({ name: Schema.String, previous: Schema.String }),
  "release.published": Schema.Struct({
    id: Schema.Finite,
    tag: Schema.String,
    name: Schema.NullOr(Schema.String),
    prerelease: Schema.Boolean,
    url: Schema.String
  }),
  "workflow.started": Schema.Struct(Run),
  "workflow.completed": Schema.Struct({ ...Run, conclusion: Schema.NullOr(Schema.String) })
} as const

export type EventType = keyof typeof payloads

export const descriptions: Record<EventType, string> = {
  "tag.created": "A tag matching tags appears",
  "tag.moved": "A tag matching tags points at another commit",
  "branch.created": "A branch matching branches appears",
  "branch.moved": "The head of a branch matching branches changes",
  "branch.deleted": "A branch matching branches is deleted",
  "release.published": "A release whose tag matches releases is published",
  "workflow.started": "A run, or a new attempt of a run, of a workflow named in workflows is queued or starts",
  "workflow.completed": "A run of a workflow named in workflows completes, with its conclusion"
}

interface Fields<K extends EventType> {
  readonly type: K
  readonly occurredAt: string
  readonly summary: string
  readonly payload: (typeof payloads)[K]["Type"]
  readonly link: string | null
  readonly dedupeKey: string
}

export type Emitted = { readonly [K in EventType]: Fields<K> }[EventType]
