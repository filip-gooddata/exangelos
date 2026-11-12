import { describe, expect, it } from "@effect/vitest"
import { type Filters, type Memory, noFilters, type Step, step } from "../src/Diff.ts"
import type { Snapshot } from "../src/Snapshot.ts"
import { check, comment, review, snapshot, thread } from "./fixtures.ts"

const now = "2026-11-12T12:00:00Z"

/** Runs polls in order and returns the event types and dedupe keys of the last one. */
const poll = (snapshots: ReadonlyArray<Snapshot>, filters: Filters = noFilters) => {
  let memory: Memory | undefined
  let last: Step | undefined
  for (const next of snapshots) {
    last = step(memory, next, filters, now)
    memory = last.memory
  }
  return last!
}

const keys = (snapshots: ReadonlyArray<Snapshot>, filters?: Filters) =>
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
    const filters: Filters = { checks: [/^codecov/], authors: [/\[bot\]$/], comments: [/^\/retest/] }
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

  it("ends on merged and on closed", () => {
    expect(poll([snapshot(), snapshot({ state: "MERGED", mergedAt: now })]).end).toBe("merged")
    expect(poll([snapshot(), snapshot({ state: "CLOSED", closedAt: now })]).end).toBe("closed")
    expect(poll([snapshot()]).end).toBeNull()
  })
})
