import type { Check, Comment, Review, ReviewRequest, Snapshot, Thread, ThreadReply } from "../src/Snapshot.ts"

export const url = "https://github.com/acme/api/pull/7"

export const snapshot = (overrides: Partial<Snapshot> = {}): Snapshot => ({
  url,
  title: "Add retries",
  state: "OPEN",
  isDraft: false,
  mergedAt: null,
  closedAt: null,
  author: "olga",
  head: "a".repeat(40),
  base: { name: "main", oid: "b".repeat(40) },
  mergeable: "MERGEABLE",
  mergeStateStatus: "BLOCKED",
  reviewDecision: "REVIEW_REQUIRED",
  checks: [],
  requiredChecks: [],
  reviews: [],
  comments: [],
  threads: [],
  requestedReviewers: [],
  reviewRequests: [],
  draftEvents: [],
  reviewerFirstReviewAt: null,
  ...overrides
})

export const check = (name: string, outcome: Check["outcome"], overrides: Partial<Check> = {}): Check => ({
  id: `check-${name}-${outcome}`,
  kind: "run",
  name,
  outcome,
  succeeded: outcome === "passed",
  required: false,
  url: `https://github.com/acme/api/runs/${name}`,
  completedAt: outcome === "pending" ? null : "2026-11-12T10:05:00Z",
  ...overrides
})

export const review = (id: string, author: string, submittedAt: string, state = "CHANGES_REQUESTED"): Review => ({
  id,
  author,
  state,
  body: "Please add a test",
  submittedAt,
  url: `${url}#pullrequestreview-${id}`,
  commit: "a".repeat(40)
})

export const comment = (id: string, author: string, createdAt: string, body = "Looks good"): Comment => ({
  id,
  author,
  body,
  createdAt,
  url: `${url}#issuecomment-${id}`
})

export const thread = (
  id: string,
  author: string,
  createdAt: string,
  isResolved = false,
  replies: ReadonlyArray<ThreadReply> = []
): Thread => ({
  id,
  isResolved,
  path: "src/retry.ts",
  openerId: `${id}-opener`,
  openerReview: null,
  author,
  body: "Off by one?",
  createdAt,
  url: `${url}#discussion_r${id}`,
  replies
})

export const reply = (id: string, author: string, createdAt: string, body = "Fixed"): ThreadReply => ({
  id,
  author,
  body,
  createdAt,
  url: `${url}#discussion_r${id}`,
  review: null
})

export const request = (id: string, reviewer: string, createdAt: string): ReviewRequest => ({ id, reviewer, createdAt })
