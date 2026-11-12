import type { Check, Comment, Review, Snapshot, Thread } from "../src/Snapshot.ts"

export const url = "https://github.com/acme/api/pull/7"

export const snapshot = (overrides: Partial<Snapshot> = {}): Snapshot => ({
  url,
  title: "Add retries",
  state: "OPEN",
  isDraft: false,
  mergedAt: null,
  closedAt: null,
  head: "a".repeat(40),
  base: { name: "main", oid: "b".repeat(40) },
  mergeable: "MERGEABLE",
  reviewDecision: "REVIEW_REQUIRED",
  checks: [],
  requiredChecks: [],
  reviews: [],
  comments: [],
  threads: [],
  ...overrides
})

export const check = (name: string, outcome: Check["outcome"], overrides: Partial<Check> = {}): Check => ({
  id: `check-${name}-${outcome}`,
  name,
  outcome,
  required: false,
  url: `https://github.com/acme/api/runs/${name}`,
  completedAt: outcome === "pending" ? null : "2026-11-12T10:05:00Z",
  ...overrides
})

export const review = (id: string, author: string, submittedAt: string): Review => ({
  id,
  author,
  state: "CHANGES_REQUESTED",
  body: "Please add a test",
  submittedAt,
  url: `${url}#pullrequestreview-${id}`
})

export const comment = (id: string, author: string, createdAt: string, body = "Looks good"): Comment => ({
  id,
  author,
  body,
  createdAt,
  url: `${url}#issuecomment-${id}`
})

export const thread = (id: string, author: string, createdAt: string, isResolved = false): Thread => ({
  id,
  isResolved,
  path: "src/retry.ts",
  author,
  body: "Off by one?",
  createdAt,
  url: `${url}#discussion_r${id}`
})
