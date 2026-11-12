import { describe, expect, it } from "@effect/vitest"
import { Duration, Effect, Option, Schedule } from "effect"
import type { Wake } from "../src/index.ts"
import { Delivery, Ids } from "../src/index.ts"
import { at, event, later, limits, plugin, subscription } from "./fixtures.ts"

const now = at("2026-11-02T10:00:00Z")

const wake = (overrides: Partial<Wake.Wake> = {}): Wake.Wake => ({
  id: Ids.WakeId.make("wake_1"),
  subscription: Ids.SubscriptionId.make("sub_7f3k"),
  reason: "events",
  through: 1,
  state: "waiting",
  attempts: { count: 0, nextAttemptAt: later(now, "5 seconds") },
  createdAt: now,
  ...overrides
})

describe("Delivery", () => {
  it("rule 8: the first pending event opens a 5 second window that later events join", () => {
    const opened = Delivery.plan(Option.none(), {
      id: Ids.WakeId.make("wake_1"),
      why: { _tag: "Events" },
      subscription: subscription({ lastNumber: 1 }),
      now
    }, limits)
    expect(opened).toEqual([wake()])

    const joined = Delivery.plan(Option.some(wake()), {
      id: Ids.WakeId.make("wake_2"),
      why: { _tag: "Events" },
      subscription: subscription({ lastNumber: 2 }),
      now: later(now, "2 seconds")
    }, limits)
    expect(joined).toEqual([wake({ through: 2 })])
  })

  it("rule 9: a later event replaces the undelivered wake with a new one sent at once", () => {
    const failing = wake({ attempts: { count: 2, lastError: "offline", nextAttemptAt: later(now, "1 minute") } })
    const sent = later(now, "30 seconds")
    expect(
      Delivery.plan(Option.some(failing), {
        id: Ids.WakeId.make("wake_2"),
        why: { _tag: "Events" },
        subscription: subscription({ lastNumber: 3, ackedThrough: 1 }),
        now: sent
      }, limits)
    ).toEqual([
      { ...failing, state: "replaced" },
      wake({ id: Ids.WakeId.make("wake_2"), through: 3, createdAt: sent, attempts: { count: 0, nextAttemptAt: sent } })
    ])
  })

  it("rule 10: retries at most 10 minutes apart until nothing is left to say", () =>
    Effect.gen(function*() {
      const step = yield* Schedule.toStep(Delivery.retrySchedule(limits))
      const delays: Array<number> = []
      for (let attempt = 0; attempt < 9; attempt++) {
        const [, delay] = yield* step(0, undefined)
        delays.push(Duration.toSeconds(delay))
      }
      expect(delays).toEqual([5, 10, 20, 40, 80, 160, 320, 600, 600])
      expect(Delivery.retry(wake({ attempts: { count: 7 } }), "offline", now, limits).attempts).toEqual({
        count: 8,
        lastError: "offline",
        nextAttemptAt: later(now, "10 minutes")
      })
      expect(Delivery.hasSomethingToSay(wake({ through: 3 }), subscription({ lastNumber: 3, ackedThrough: 2 }), plugin()))
      .toBe(true)
    expect(Delivery.hasSomethingToSay(wake({ through: 3 }), subscription({ lastNumber: 3, ackedThrough: 3 }), plugin()))
      .toBe(false)
    expect(Delivery.hasSomethingToSay(wake({ reason: "paused" }), subscription(), plugin())).toBe(false)
    expect(Delivery.hasSomethingToSay(wake({ reason: "suspended" }), subscription(), plugin())).toBe(false)
    }).pipe(Effect.runSync))

  it("lists every pending event in the wake content and never the intent", () => {
    const content = Delivery.content(subscription({ lastNumber: 5, ackedThrough: 3 }), { _tag: "Events" }, [
      event(5, { summary: "review" }),
      event(3),
      event(4, { summary: "checks" })
    ])
    expect(content).toEqual({
      subscription: "sub_7f3k",
      plugin: "github-pr",
      subject: "acme/app#123",
      why: { _tag: "Events" },
      pending: [
        { number: 4, type: "checks.failed", summary: "checks" },
        { number: 5, type: "checks.failed", summary: "review" }
      ]
    })
  })

  it("rule 12: wait returns what the wake would say, or nothing while there is nothing to say", () => {
    expect(Delivery.waitContent(subscription(), [], Option.none())).toEqual(Option.none())
    expect(Option.map(Delivery.waitContent(subscription({ lastNumber: 1 }), [event(1)], Option.none()), (c) => c.why))
      .toEqual(Option.some({ _tag: "Events" }))
    expect(
      Option.map(Delivery.waitContent(subscription({ state: { _tag: "Expired" } }), [], Option.none()), (c) => c.why)
    ).toEqual(Option.some({ _tag: "Expired" }))
  })
})
