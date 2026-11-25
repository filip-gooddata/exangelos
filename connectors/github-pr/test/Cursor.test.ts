import { describe, expect, it } from "@effect/vitest"
import * as Cursor from "../src/Cursor.ts"
import { noFilters, step } from "../src/Diff.ts"
import { reply, snapshot, thread } from "./fixtures.ts"

const v1 = JSON.stringify({
  v: 1,
  head: "a".repeat(40),
  base: { name: "main", oid: "b".repeat(40) },
  conflictReported: false,
  failedReported: [],
  passedReported: false,
  readyReported: false,
  reviews: { at: null, ids: [] },
  comments: { at: "2026-11-12T10:00:00Z", ids: ["c1"] },
  threads: { at: "2026-11-12T09:00:00Z", ids: ["t1"] }
})

describe("cursor", () => {
  it("round-trips a v2 cursor", () => {
    const memory = step(undefined, snapshot({ isDraft: true }), noFilters, "2026-11-12T12:00:00Z").memory

    expect(Cursor.encode(memory)).toContain(`"v":2`)
    expect(Cursor.decode(Cursor.encode(memory))).toEqual(memory)
  })

  it("carries a v1 cursor over, reporting replies newer than its latest activity and nothing it already reported", () => {
    const memory = Cursor.decode(v1)
    const threads = [thread("t1", "ana", "2026-11-12T09:00:00Z", false, [
      reply("p0", "bo", "2026-11-12T09:30:00Z"),
      reply("p1", "bo", "2026-11-12T10:30:00Z")
    ])]

    expect(memory).toMatchObject({ replies: { at: "2026-11-12T10:00:00Z" }, draft: null })
    const events = step(memory, snapshot({ isDraft: true, threads }), noFilters, "2026-11-12T12:00:00Z").events
    expect(events.map((e) => e.dedupeKey)).toEqual(["review.reply/p1"])
  })

  it("starts over on a cursor it cannot read", () => {
    expect(Cursor.decode(`{"v":9}`)).toBeUndefined()
  })
})
