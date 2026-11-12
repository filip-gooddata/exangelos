import { describe, expect, it } from "@effect/vitest"
import { Retention } from "../src/index.ts"
import { later, limits, start, subscription } from "./fixtures.ts"

describe("Retention", () => {
  it("deletes closed subscriptions and cancels expired ones nobody resumed after 30 days", () => {
    const month = later(start, "30 days")
    const ended = subscription({ state: { _tag: "Ended", reason: { _tag: "MaxEvents" } } })
    const expired = subscription({ state: { _tag: "Expired" } })
    expect(Retention.decide(ended, later(start, "29 days"), limits)).toEqual({ _tag: "Keep" })
    expect(Retention.decide(ended, month, limits)).toEqual({ _tag: "Delete" })
    expect(Retention.decide(expired, month, limits)).toMatchObject({
      _tag: "Cancel",
      subscription: { state: { _tag: "Cancelled", actor: { _tag: "You" } }, stateSince: month }
    })
    expect(Retention.decide(subscription(), month, limits)).toEqual({ _tag: "Keep" })
  })
})
