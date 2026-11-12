import { describe, expect, it } from "@effect/vitest"
import { Effect, Option } from "effect"
import { TestClock } from "effect/testing"
import { SubscriptionRepository } from "../../../src/ports/SubscriptionRepository.ts"
import { SubscriptionIntake } from "../../../src/seam/SubscriptionIntake.ts"
import { sweepLimits, sweepRetention } from "../../../src/subscriptions/daemon/Sweeps.ts"
import { eventsOf, layer, reload, reported, seed, session, wakesOf } from "./support.ts"

const undeliveredReasons = (subscription: Parameters<typeof wakesOf>[0]) =>
  Effect.map(wakesOf(subscription), (wakes) =>
    wakes.filter((wake) => wake.state === "waiting").map((wake) => wake.reason))

describe("sweepLimits", () => {
  it.effect("pauses an active subscription whose oldest pending event is a day old", () =>
    Effect.gen(function*() {
      const intake = yield* SubscriptionIntake
      const subscription = yield* seed()
      yield* intake.ingest(subscription.id, { _tag: "Event", event: reported("a") })
      yield* TestClock.adjust("24 hours")

      yield* sweepLimits

      expect((yield* reload(subscription)).state._tag).toBe("Paused")
      expect(yield* undeliveredReasons(subscription)).toEqual(["paused"])
    }).pipe(Effect.provide(layer)))

  it.effect("expires an active subscription with a wake and a paused one without", () =>
    Effect.gen(function*() {
      const subscriptions = yield* SubscriptionRepository
      const active = yield* seed()
      const paused = yield* seed()
      yield* subscriptions.store({
        ...paused,
        state: { _tag: "Paused", reason: { _tag: "Actor", actor: { _tag: "Session", session } } }
      })
      yield* TestClock.adjust("7 days")

      yield* sweepLimits

      expect((yield* reload(active)).state._tag).toBe("Expired")
      expect((yield* reload(paused)).state._tag).toBe("Expired")
      expect(yield* undeliveredReasons(active)).toEqual(["expired"])
      expect(yield* undeliveredReasons(paused)).toEqual([])
    }).pipe(Effect.provide(layer)))
})

describe("sweepRetention", () => {
  it.effect("deletes a subscription closed for 30 days and cancels one expired for 30 days", () =>
    Effect.gen(function*() {
      const intake = yield* SubscriptionIntake
      const subscriptions = yield* SubscriptionRepository
      const closed = yield* seed()
      const expired = yield* seed()
      yield* intake.ingest(closed.id, { _tag: "Event", event: reported("a") })
      yield* intake.ingest(closed.id, { _tag: "End", reason: "closed" })
      yield* subscriptions.store({ ...expired, state: { _tag: "Expired" } })

      yield* TestClock.adjust("29 days")
      yield* sweepRetention
      expect(Option.isSome(yield* subscriptions.find(closed.id))).toBe(true)

      yield* TestClock.adjust("1 day")
      yield* sweepRetention

      expect(Option.isNone(yield* subscriptions.find(closed.id))).toBe(true)
      expect(yield* eventsOf(closed)).toEqual([])
      expect((yield* reload(expired)).state).toEqual({ _tag: "Cancelled", actor: { _tag: "You" } })
    }).pipe(Effect.provide(layer)))
})
