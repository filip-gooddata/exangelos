import { Schema } from "effect"

const Branch = Schema.Struct({ name: Schema.String, oid: Schema.String })

/** Payload schemas, one per event type, shared by the diff and the catalogue. */
export const payloads = {
  "head.changed": Schema.Struct({ previous: Schema.String, head: Schema.String }),
  "base.changed": Schema.Struct({ previous: Branch, base: Branch }),
  "conflict.detected": Schema.Struct({ head: Schema.String, base: Branch }),
  "checks.failed": Schema.Struct({
    name: Schema.String,
    outcome: Schema.Literals(["failed", "cancelled"]),
    required: Schema.Boolean,
    head: Schema.String
  }),
  "checks.passed": Schema.Struct({ head: Schema.String, checks: Schema.Array(Schema.String) }),
  "review.submitted": Schema.Struct({ id: Schema.String, author: Schema.String, state: Schema.String, body: Schema.String }),
  "review.thread": Schema.Struct({ id: Schema.String, author: Schema.String, path: Schema.String, body: Schema.String }),
  "comment.added": Schema.Struct({ id: Schema.String, author: Schema.String, body: Schema.String }),
  "merge.ready": Schema.Struct({ head: Schema.String, reviewDecision: Schema.NullOr(Schema.String) })
} as const

export type EventType = keyof typeof payloads

export const descriptions: Record<EventType, string> = {
  "head.changed": "The head commit changes",
  "base.changed": "The head of the base branch changes",
  "conflict.detected": "The pull request conflicts with its base",
  "checks.failed": "A check fails or is cancelled",
  "checks.passed": "Every check is complete and none failed",
  "review.submitted": "Someone submits a review",
  "review.thread": "A new unresolved review thread appears",
  "comment.added": "Someone adds a comment to the conversation",
  "merge.ready": "The pull request is open, mergeable, approved or needs no review, and its required checks passed; once per head"
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
