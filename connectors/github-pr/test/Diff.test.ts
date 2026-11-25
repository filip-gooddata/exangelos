import { describe, expect, it } from "@effect/vitest"
import { Diff, type Snapshot } from "../src/index.ts"

const { noFilters, step } = Diff
type Filters = Diff.Filters
type Memory = Diff.Memory
type Step = Diff.Step
import { check, comment, reply, request, review, snapshot, thread } from "./fixtures.ts"

const now = "2026-11-12T12:00:00Z"

const poll = (snapshots: ReadonlyArray<Snapshot.Snapshot>, filters: Filters = noFilters) => {
  let memory: Memory | undefined
  let last: Step | undefined
  for (const next of snapshots) {
    last = step(memory, next, filters, now)
    memory = last.memory
  }
  return last!
}

const keys = (snapshots: ReadonlyArray<Snapshot.Snapshot>, filters?: Filters) =>
  poll(snapshots, filters).events.map((e) => e.dedupeKey)

const head = "a".repeat(40)
const newHead = "c".repeat(40)
const baseOid = "b".repeat(40)

describe("step", () => {
  it("raises nothing for history before the first poll, nor for a repeated poll", () => {
    const busy = snapshot({
      reviews: [review("r1", "ana", "2026-11-12T09:00:00Z")],
      comments: [comment("c1", "ana", "2026-11-12T09:00:00Z")],
      threads: [thread("t1", "ana", "2026-11-12T09:00:00Z")]
    })

    expect(keys([busy])).toEqual([])
    expect(keys([busy, busy])).toEqual([])
  })

  it("reports a new head and a moved base", () => {
    const moved = snapshot({ head: newHead, base: { name: "main", oid: "d".repeat(40) } })

    expect(keys([snapshot(), moved])).toEqual([
      `head.changed/${newHead}`,
      `base.changed/main/${"d".repeat(40)}`
    ])
  })

  it("reports a conflict once per head and base", () => {
    const conflicting = snapshot({ mergeable: "CONFLICTING" })

    expect(keys([snapshot(), conflicting])).toEqual([`conflict.detected/${head}/${baseOid}`])
    expect(keys([conflicting, snapshot({ mergeable: "UNKNOWN" }), conflicting])).toEqual([])
  })

  it("reports each failed or cancelled check once, then the passing run", () => {
    const failing = snapshot({ checks: [check("lint", "failed"), check("e2e", "cancelled"), check("unit", "pending")] })
    const rerun = snapshot({
      checks: [
        check("lint", "failed"),
        check("lint", "passed", { completedAt: "2026-11-12T11:00:00Z" }),
        check("e2e", "passed", { completedAt: "2026-11-12T11:00:00Z" }),
        check("unit", "passed")
      ]
    })

    expect(keys([failing])).toEqual([`checks.failed/${head}/check-lint-failed`, `checks.failed/${head}/check-e2e-cancelled`])
    expect(keys([failing, failing])).toEqual([])
    expect(keys([failing, rerun])).toEqual([`checks.passed/${head}`])
  })

  it("waits for a required check that has not posted before reporting passed checks", () => {
    const missing = snapshot({ checks: [check("lint", "passed")], requiredChecks: ["build"] })
    const posted = snapshot({ checks: [check("lint", "passed"), check("build", "passed")], requiredChecks: ["build"] })

    expect(keys([missing])).toEqual([])
    expect(keys([missing, posted])).toEqual([`checks.passed/${head}`])
  })

  it("reports new reviews, unresolved threads and comments", () => {
    const later = snapshot({
      reviews: [review("r1", "ana", "2026-11-12T11:00:00Z")],
      comments: [comment("c1", "ana", "2026-11-12T11:00:00Z")],
      threads: [thread("t1", "ana", "2026-11-12T11:00:00Z"), thread("t2", "bo", "2026-11-12T11:01:00Z", true)]
    })

    const events = poll([snapshot(), later]).events
    expect(events.map((e) => e.dedupeKey)).toEqual(["review.thread/t1", "review.submitted/r1", "comment.added/c1"])
    expect(events[0]).toMatchObject({ occurredAt: "2026-11-12T11:00:00Z", link: expect.stringContaining("discussion_rt1") })
  })

  it("tells apart items that share a timestamp with the last one seen", () => {
    const one = snapshot({ comments: [comment("c1", "ana", "2026-11-12T11:00:00Z")] })
    const two = snapshot({ comments: [comment("c1", "ana", "2026-11-12T11:00:00Z"), comment("c2", "bo", "2026-11-12T11:00:00Z")] })

    expect(keys([snapshot(), one, two])).toEqual(["comment.added/c2"])
  })

  it("skips checks, authors and comments that match the ignore patterns", () => {
    const filters: Filters = { ...noFilters, checks: [/^codecov/], authors: [/\[bot\]$/], comments: [/^\/retest/] }
    const later = snapshot({
      checks: [check("codecov/patch", "failed"), check("lint", "failed")],
      reviews: [review("r1", "renovate[bot]", "2026-11-12T11:00:00Z")],
      comments: [comment("c1", "ana", "2026-11-12T11:00:00Z", "/retest please"), comment("c2", "dependabot[bot]", "2026-11-12T11:00:00Z")],
      threads: [thread("t1", "renovate[bot]", "2026-11-12T11:00:00Z")]
    })

    expect(keys([snapshot(), later], filters)).toEqual([`checks.failed/${head}/check-lint-failed`])
  })

  it("reports readiness once per head", () => {
    const ready = snapshot({
      reviewDecision: "APPROVED",
      checks: [check("build", "passed", { required: true }), check("docs", "pending")]
    })
    const readyAgain = { ...ready, head: newHead }

    expect(keys([snapshot(), ready])).toEqual([`merge.ready/${head}`])
    expect(keys([ready, ready])).toEqual([])
    expect(keys([ready, readyAgain])).toEqual([`head.changed/${newHead}`, `merge.ready/${newHead}`])
  })

  it("is not ready while a draft, unapproved or with a required check running", () => {
    const base = { reviewDecision: "APPROVED" as const, checks: [check("build", "passed", { required: true })] }

    expect(keys([snapshot({ ...base, isDraft: true })])).not.toContain(`merge.ready/${head}`)
    expect(keys([snapshot({ ...base, reviewDecision: "CHANGES_REQUESTED" })])).not.toContain(`merge.ready/${head}`)
    expect(keys([snapshot({ ...base, checks: [check("build", "pending", { required: true })] })])).toEqual([])
  })

  it("is not ready while a required check fails, even one it is told to ignore or one a status of the same name passes", () => {
    const approved = { reviewDecision: "APPROVED" as const }
    const ignoredFailure = snapshot({ ...approved, checks: [check("build", "failed", { required: true })] })
    const shadowed = snapshot({
      ...approved,
      checks: [check("build", "failed", { required: true }), check("build", "passed", { kind: "status", id: "status-build" })]
    })

    expect(keys([ignoredFailure], { ...noFilters, checks: [/^build$/] })).toEqual([])
    expect(keys([shadowed])).toEqual([`checks.failed/${head}/check-build-failed`])
  })

  it("ends on merged and on closed", () => {
    expect(poll([snapshot(), snapshot({ state: "MERGED", mergedAt: now })]).end).toBe("merged")
    expect(poll([snapshot(), snapshot({ state: "CLOSED", closedAt: now })]).end).toBe("closed")
    expect(poll([snapshot()]).end).toBeNull()
  })

  it("reports every draft change after the first poll, ready to draft included", () => {
    const draft = snapshot({ isDraft: true })
    const ready = snapshot({ isDraft: false })

    expect(keys([draft])).toEqual([])
    const flips = [draft, ready, draft, ready].map((s, i, all) => poll(all.slice(0, i + 1)).events.map((e) => e.dedupeKey))
    expect(flips).toEqual([
      [],
      [`draft.changed/${head}/draft-ready/1`],
      [`draft.changed/${head}/ready-draft/2`],
      [`draft.changed/${head}/draft-ready/3`]
    ])
  })

  it("reports replies in any thread, resolved too, but not the opening comment or ignored ones", () => {
    const opened = thread("t1", "ana", "2026-11-12T09:00:00Z", true)
    const answered = {
      ...opened,
      replies: [
        reply("p1", "bo", "2026-11-12T11:00:00Z"),
        reply("p2", "renovate[bot]", "2026-11-12T11:01:00Z"),
        reply("p3", "bo", "2026-11-12T11:02:00Z", "/retest")
      ]
    }
    const filters = { ...noFilters, authors: [/\[bot\]$/], comments: [/^\/retest/] }

    const events = poll([snapshot({ threads: [opened] }), snapshot({ threads: [answered] })], filters).events
    expect(events.map((e) => e.dedupeKey)).toEqual(["review.reply/p1"])
    expect(events[0]?.payload).toEqual({
      threadId: "t1",
      commentId: "p1",
      author: "bo",
      path: "src/retry.ts",
      body: "Fixed",
      isResolved: true
    })
  })

  it("mutes a thread with its replies, and a comment, by URL or id", () => {
    const filters = { ...noFilters, ignoreIds: [`https://github.com/acme/api/pull/7#discussion_rt1`, "c1"] }
    const later = snapshot({
      threads: [thread("t1", "ana", "2026-11-12T11:00:00Z", false, [reply("p1", "bo", "2026-11-12T11:01:00Z")])],
      comments: [comment("c1", "ana", "2026-11-12T11:00:00Z"), comment("c2", "ana", "2026-11-12T11:00:00Z")]
    })

    expect(keys([snapshot(), later], filters)).toEqual(["comment.added/c2"])
  })

  it("reports the unresolved threads on the first poll when asked", () => {
    const busy = snapshot({ threads: [thread("t1", "ana", "2026-11-12T09:00:00Z"), thread("t2", "bo", "2026-11-12T09:00:00Z", true)] })

    expect(keys([busy], { ...noFilters, existingThreads: true })).toEqual(["review.thread/t1"])
    expect(keys([busy, busy], { ...noFilters, existingThreads: true })).toEqual([])
  })

  it("compares the base with a pinned SHA, or with the base it saw first", () => {
    const moved = snapshot({ base: { name: "main", oid: "d".repeat(40) } })
    const pinned = { ...noFilters, baseHead: "bbbbbbb" }
    const current = { ...noFilters, baseHead: "current" }

    expect(keys([snapshot()], pinned)).toEqual([])
    expect(keys([moved], pinned)).toEqual([`base.changed/main/${"d".repeat(40)}`])
    expect(keys([moved, moved], pinned)).toEqual([])
    expect(keys([snapshot()], current)).toEqual([])
    expect(keys([snapshot(), moved], current)).toEqual([`base.changed/main/${"d".repeat(40)}`])
    expect(keys([snapshot(), moved, snapshot()], current)).toEqual([])
  })

  it("reports a DIRTY merge state as a conflict", () => {
    expect(keys([snapshot({ mergeStateStatus: "DIRTY" })])).toEqual([`conflict.detected/${head}/${baseOid}`])
  })

  it("reports each matching check that passed once per head, from the first poll", () => {
    const filters = { ...noFilters, checkPass: [/^deploy/] }
    const green = snapshot({ checks: [check("deploy-preview", "passed"), check("lint", "passed"), check("unit", "pending")] })

    expect(keys([green], filters)).toEqual([`check.passed/${head}/deploy-preview`])
    expect(keys([green, green], filters)).toEqual([])
    expect(keys([green, { ...green, head: newHead }], filters)).toEqual([
      `head.changed/${newHead}`,
      `check.passed/${newHead}/deploy-preview`
    ])
  })

  it("waits for readyWait checks before merge.ready", () => {
    const filters = { ...noFilters, readyWait: [/review/] }
    const reviewing = snapshot({ reviewDecision: "APPROVED", checks: [check("ai-review", "pending")] })
    const reviewed = snapshot({ reviewDecision: "APPROVED", checks: [check("ai-review", "failed")] })

    expect(keys([reviewing], filters)).toEqual([])
    expect(keys([reviewing, reviewed], filters)).toEqual([`checks.failed/${head}/check-ai-review-failed`, `merge.ready/${head}`])
  })

  it("drops review states the subscriber leaves out", () => {
    const later = snapshot({
      reviews: [review("r1", "ana", "2026-11-12T11:00:00Z", "COMMENTED"), review("r2", "bo", "2026-11-12T11:01:00Z", "APPROVED")]
    })

    expect(keys([snapshot(), later], { ...noFilters, reviewStates: ["APPROVED", "CHANGES_REQUESTED"] }))
      .toEqual(["review.submitted/r2"])
  })

  describe("reviewer mode", () => {
    const filters = { ...noFilters, reviewer: "vera" }

    it("reports the reviewer's own reviews in any state, and nothing without the parameter", () => {
      const later = snapshot({ reviews: [review("r1", "vera", "2026-11-12T11:00:00Z", "COMMENTED")] })

      const events = poll([snapshot(), later], filters).events
      expect(events.map((e) => e.dedupeKey)).toEqual(["review.submitted/r1", "reviewer.submitted/r1"])
      expect(events[1]?.payload).toMatchObject({ state: "COMMENTED", reviewId: "r1", commit: head })
      expect(keys([snapshot(), later])).toEqual(["review.submitted/r1"])
    })

    it("reports a request to review again only after an earlier review", () => {
      const reviewed = snapshot({ reviews: [review("r1", "vera", "2026-11-12T09:00:00Z")] })
      const asked = { ...reviewed, requestedReviewers: ["vera"], reviewRequests: [request("q1", "vera", "2026-11-12T08:00:00Z"), request("q2", "vera", "2026-11-12T11:00:00Z")] }
      const firstAsk = snapshot({ requestedReviewers: ["vera"], reviewRequests: [request("q1", "vera", "2026-11-12T08:00:00Z")] })

      expect(keys([reviewed, asked], filters)).toEqual(["review.rerequested/q2"])
      expect(keys([asked], filters)).toEqual(["review.rerequested/q2"])
      expect(keys([snapshot(), firstAsk], filters)).toEqual([])
    })

    it("reports the author's comments and thread writing, resolved threads included", () => {
      const old = thread("t1", "vera", "2026-11-12T09:00:00Z", true)
      const later = snapshot({
        comments: [comment("c1", "olga", "2026-11-12T11:00:00Z"), comment("c2", "bo", "2026-11-12T11:00:00Z")],
        threads: [{ ...old, replies: [reply("p1", "olga", "2026-11-12T11:01:00Z")] }, thread("t2", "olga", "2026-11-12T11:02:00Z")]
      })

      expect(poll([snapshot({ threads: [old] }), later], filters).events.filter((e) => e.type === "author.activity")
        .map((e) => e.dedupeKey)).toEqual(["author.activity/c1", "author.activity/t2-opener", "author.activity/p1"])
    })
  })
})
