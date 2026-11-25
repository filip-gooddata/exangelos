import { Schema } from "effect"

const Branch = Schema.Struct({ name: Schema.String, oid: Schema.String })
const DraftState = Schema.Literals(["draft", "ready"])

export const payloads = {
  "head.changed": Schema.Struct({ previous: Schema.String, head: Schema.String }),
  "draft.changed": Schema.Struct({ head: Schema.String, from: DraftState, to: DraftState }),
  "base.changed": Schema.Struct({ previous: Branch, base: Branch }),
  "conflict.detected": Schema.Struct({ head: Schema.String, base: Branch }),
  "checks.failed": Schema.Struct({
    name: Schema.String,
    outcome: Schema.Literals(["failed", "cancelled"]),
    required: Schema.Boolean,
    head: Schema.String
  }),
  "checks.passed": Schema.Struct({ head: Schema.String, checks: Schema.Array(Schema.String) }),
  "check.passed": Schema.Struct({ name: Schema.String, head: Schema.String }),
  "review.submitted": Schema.Struct({ id: Schema.String, author: Schema.String, state: Schema.String, body: Schema.String }),
  "review.thread": Schema.Struct({ id: Schema.String, author: Schema.String, path: Schema.String, body: Schema.String }),
  "review.reply": Schema.Struct({
    threadId: Schema.String,
    commentId: Schema.String,
    author: Schema.String,
    path: Schema.String,
    body: Schema.String,
    isResolved: Schema.Boolean
  }),
  "comment.added": Schema.Struct({ id: Schema.String, author: Schema.String, body: Schema.String }),
  "merge.ready": Schema.Struct({ head: Schema.String, reviewDecision: Schema.NullOr(Schema.String) }),
  "reviewer.submitted": Schema.Struct({
    reviewer: Schema.String,
    reviewId: Schema.String,
    state: Schema.String,
    submittedAt: Schema.String,
    commit: Schema.NullOr(Schema.String)
  }),
  "review.rerequested": Schema.Struct({
    reviewer: Schema.String,
    requestId: Schema.String,
    requestedAt: Schema.String,
    reviewedAt: Schema.String
  }),
  "author.activity": Schema.Struct({
    author: Schema.String,
    kind: Schema.Literals(["comment", "thread", "reply"]),
    id: Schema.String,
    threadId: Schema.NullOr(Schema.String),
    path: Schema.NullOr(Schema.String),
    body: Schema.String
  })
} as const

export type EventType = keyof typeof payloads

export const descriptions: Record<EventType, string> = {
  "head.changed": "The head commit changes",
  "draft.changed": "The pull request turns draft or ready for review",
  "base.changed": "The head of the base branch changes, or differs from the pinned baseHead",
  "conflict.detected": "The pull request conflicts with its base (mergeable CONFLICTING or merge state DIRTY)",
  "checks.failed": "A check fails or is cancelled",
  "checks.passed": "Every check is complete and none failed",
  "check.passed": "A check matching wakeOnCheckPass passed; once per check per head",
  "review.submitted": "Someone submits a review",
  "review.thread": "A new unresolved review thread appears",
  "review.reply": "Someone replies in a review thread, resolved or not",
  "comment.added": "Someone adds a comment to the conversation",
  "merge.ready": "The pull request is open, mergeable, approved or needs no review, and its required checks and readyWait checks passed; once per head",
  "reviewer.submitted": "Reviewer mode: the reviewer submits a review in any state",
  "review.rerequested": "Reviewer mode: the reviewer is asked to review again after an earlier review",
  "author.activity": "Reviewer mode: the pull request's author comments or writes in a review thread"
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
