import { describe, expect, it } from "@effect/vitest"
import { Duration } from "effect"
import { Ids, Wake } from "@exangelos/domain"
import { WakeText } from "@exangelos/contracts"

const base = {
  subscription: Ids.SubscriptionId.make("sub_7f3k"),
  connector: "github-pr",
  subject: "acme/app#123"
}

describe("WakeText", () => {
  it("lists pending events with read and ack commands", () => {
    const content: Wake.WakeContent = {
      ...base,
      why: { _tag: "Events" },
      pending: [
        { number: 4, type: "checks.failed", summary: "build and e2e failed" },
        { number: 5, type: "review.submitted", summary: "alice requested changes" }
      ]
    }
    expect(WakeText.render(content)).toBe(
      [
        "2 events on sub_7f3k (github-pr, acme/app#123)",
        "  #4 checks.failed      build and e2e failed",
        "  #5 review.submitted   alice requested changes",
        "Read  exangelos events sub_7f3k",
        "Ack   exangelos ack sub_7f3k --through 5"
      ].join("\n")
    )
  })

  it("includes the pending event when the subscription reaches its cap", () => {
    const content: Wake.WakeContent = {
      ...base,
      why: { _tag: "Ended", reason: { _tag: "MaxEvents" } },
      pending: [{ number: 1, type: "checks.failed", summary: "build failed" }]
    }
    expect(WakeText.render(content)).toBe([
      "sub_7f3k has ended (github-pr, acme/app#123)",
      "It reached its number of events.",
      "  #1 checks.failed   build failed",
      "Read  exangelos events sub_7f3k",
      "Ack   exangelos ack sub_7f3k --through 1"
    ].join("\n"))
  })

  it("tells a session its subscription paused at the backlog age", () => {
    const content: Wake.WakeContent = {
      ...base,
      why: { _tag: "Paused", reason: { _tag: "BacklogAge", limit: Duration.hours(24) } },
      pending: [{ number: 5, type: "review.submitted", summary: "alice requested changes" }]
    }
    expect(WakeText.render(content)).toBe(
      [
        "sub_7f3k is paused (github-pr, acme/app#123)",
        "Event #5 has been pending for 24 hours. Nothing is watched while paused.",
        "Ack     exangelos ack sub_7f3k --through 5",
        "Resume  exangelos resume sub_7f3k"
      ].join("\n")
    )
  })
})
