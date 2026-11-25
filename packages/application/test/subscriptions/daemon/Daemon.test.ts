import { describe, expect, it } from "@effect/vitest"
import { DateTime, Duration, Effect, Fiber, Option } from "effect"
import { WakeTargetFake } from "@exangelos/application/testing"
import { TestClock } from "effect/testing"
import { WakeTarget } from "../../../src/ports/WakeTarget.ts"
import { SubscriptionIntake } from "../../../src/seam/SubscriptionIntake.ts"
import { runSubscriptionDaemon } from "../../../src/subscriptions/daemon/Daemon.ts"
import { deliveryTimeout } from "../../../src/subscriptions/daemon/Delivery.ts"
import { layer, reload, reported, seed, wakesOf } from "./support.ts"

describe("runSubscriptionDaemon", () => {
  it.effect("sends a wake once its window closes", () =>
    Effect.gen(function*() {
      const intake = yield* SubscriptionIntake
      const target = yield* WakeTargetFake
      const subscription = yield* seed()
      const daemon = yield* Effect.forkChild(runSubscriptionDaemon)
      yield* intake.ingest(subscription.id, { _tag: "Event", event: reported("a") })

      yield* TestClock.adjust("4 seconds")
      expect(yield* target.delivered).toEqual([])
      yield* TestClock.adjust("2 seconds")
      expect((yield* target.delivered).map((content) => content.why._tag)).toEqual(["Events"])

      yield* Fiber.interrupt(daemon)
    }).pipe(Effect.provide(layer)))

  it.effect("times out a hung delivery into a retry while time limits keep applying", () =>
    Effect.gen(function*() {
      const intake = yield* SubscriptionIntake
      const hung = yield* seed()
      const ending = yield* seed({
        wakeTarget: Option.none(),
        endAt: DateTime.addDuration(yield* DateTime.now, "20 seconds")
      })
      const daemon = yield* Effect.forkChild(
        Effect.provideService(runSubscriptionDaemon, WakeTarget, { deliver: () => Effect.never })
      )
      yield* intake.ingest(hung.id, { _tag: "Event", event: reported("a") })

      yield* TestClock.adjust("26 seconds")
      expect((yield* reload(ending)).state._tag).not.toBe("Active")
      expect((yield* wakesOf(hung)).map((wake) => wake.state)).toEqual(["sending"])

      yield* TestClock.adjust(Duration.subtract(deliveryTimeout, Duration.seconds(20)))
      expect((yield* wakesOf(hung)).map((wake) => [wake.state, wake.attempts.count, wake.attempts.lastError]))
        .toEqual([["waiting", 1, "timed out"]])

      yield* Fiber.interrupt(daemon)
    }).pipe(Effect.provide(layer)))
})
