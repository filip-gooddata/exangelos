import { describe, expect, it } from "@effect/vitest"
import { Option } from "effect"
import { Ids, Intake } from "../src/index.ts"
import { at, subscription } from "./fixtures.ts"

const now = at("2026-11-02T10:00:00Z")

const reported = (type: string, dedupeKey: string) => ({
  type: Ids.EventType.make(type),
  occurredAt: now,
  summary: "build failed",
  payload: { run: 1 },
  dedupeKey
})

describe("Intake", () => {
  it("rule 6: keeps a selected event with a new dedupe key, numbers it and stores the cursor", () => {
    const watched = subscription({ eventTypes: [Ids.EventType.make("checks.failed")], lastNumber: 3, ackedThrough: 3 })
    const kept = Intake.admit({
      subscription: watched,
      reported: reported("checks.failed", "run-1"),
      cursor: Option.some("c-9"),
      duplicate: false,
      id: Ids.EventId.make("evt_4"),
      now
    })
    expect(kept.subscription).toMatchObject({ lastNumber: 4, cursor: "c-9" })
    expect(Option.getOrThrow(kept.event)).toMatchObject({ number: 4, receivedAt: now, dedupeKey: "run-1" })
    expect(kept.wake).toEqual(Option.some({ _tag: "Events" }))

    const unselected = Intake.admit({
      subscription: watched,
      reported: reported("review.submitted", "r-1"),
      cursor: Option.some("c-10"),
      duplicate: false,
      id: Ids.EventId.make("evt_5"),
      now
    })
    expect(unselected).toMatchObject({ subscription: { lastNumber: 3, cursor: "c-10" }, event: Option.none() })

    const duplicate = Intake.admit({
      subscription: watched,
      reported: reported("checks.failed", "run-1"),
      cursor: Option.none(),
      duplicate: true,
      id: Ids.EventId.make("evt_5"),
      now
    })
    expect(duplicate).toMatchObject({ subscription: { lastNumber: 3 }, event: Option.none(), wake: Option.none() })
  })

  it("active -> ended (rule 17): reaching the max events ends the subscription with a wake", () => {
    const admitted = Intake.admit({
      subscription: subscription({ maxEvents: 1 }),
      reported: reported("checks.failed", "run-1"),
      cursor: Option.none(),
      duplicate: false,
      id: Ids.EventId.make("evt_1"),
      now
    })
    expect(admitted.subscription.state).toEqual({ _tag: "Ended", reason: { _tag: "MaxEvents" } })
    expect(admitted.wake).toEqual(Option.some({ _tag: "Ended", reason: { _tag: "MaxEvents" } }))
  })

  it("rule 7: acknowledging moves acked-through forward, up to the last event, and never back", () => {
    const watched = subscription({ lastNumber: 5, ackedThrough: 2 })
    expect(Intake.acknowledge(watched, 4).ackedThrough).toBe(4)
    expect(Intake.acknowledge(watched, 9).ackedThrough).toBe(5)
    expect(Intake.acknowledge(watched, 1).ackedThrough).toBe(2)
    expect(Intake.isPending(watched, 3)).toBe(true)
    expect(Intake.isPending(watched, 2)).toBe(false)
  })
})
