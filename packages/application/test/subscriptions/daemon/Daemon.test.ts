import { describe, expect, it } from "@effect/vitest"
import { Effect, Fiber } from "effect"
import { WakeTargetFake } from "@exangelos/application/testing"
import { TestClock } from "effect/testing"
import { SubscriptionIntake } from "../../../src/seam/SubscriptionIntake.ts"
import { runSubscriptionDaemon } from "../../../src/subscriptions/daemon/Daemon.ts"
import { layer, reported, seed } from "./support.ts"

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
})
