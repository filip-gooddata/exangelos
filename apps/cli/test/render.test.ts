import { describe, expect, it } from "@effect/vitest"
import { DateTime } from "effect"
import { Ids, type Subscription } from "@exangelos/domain"
import * as Text from "../src/render/Text.ts"

const at = DateTime.makeUnsafe("2026-11-20T08:00:00Z")
const waiting: Subscription.Subscription = {
  id: Ids.SubscriptionId.make("sub_waiting"),
  connector: Ids.ConnectorName.make("slack"),
  parameters: {},
  subject: "C123/1700000000.000100",
  label: "A thread",
  intent: "Follow the thread",
  createdAt: at,
  expiresAt: at,
  state: { _tag: "Active" },
  stateSince: at,
  waiting: "Not in the local cache yet",
  lastNumber: 0,
  ackedThrough: 0,
  eventAlerts: false
}

describe("subscription text", () => {
  it("lists a waiting watch as waiting and shows its reason, unless a failure speaks instead", () => {
    expect(Text.subscriptions([waiting])).toContain("active, waiting")
    expect(Text.subscription(waiting)).toMatch(/Waiting:\s+Not in the local cache yet/)
    const failing = { ...waiting, observation: { category: "unavailable", since: at, reason: "down" } } as const
    expect(Text.subscription(failing)).not.toContain("Not in the local cache yet")
    expect(Text.subscriptions([failing])).toContain("failing (unavailable)")
  })
})
