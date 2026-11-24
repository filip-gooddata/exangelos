import { describe, expect, it } from "@effect/vitest"
import { DateTime, Duration, Effect } from "effect"
import { AlertSinkFake, WakeTargetFake } from "@exangelos/application/testing"
import { connector } from "../../fixtures.ts"
import { ConnectorRepository } from "../../../src/ports/ConnectorRepository.ts"
import { TestClock } from "effect/testing"
import { SubscriptionRepository } from "../../../src/ports/SubscriptionRepository.ts"
import { SubscriptionIntake } from "../../../src/seam/SubscriptionIntake.ts"
import { deliverDue } from "../../../src/subscriptions/daemon/Delivery.ts"
import { eventsOf, layer, reload, reported, seed, wakesOf } from "./support.ts"

describe("deliverDue", () => {
  it.effect("omits stored Slack excerpts from a retried wake after previews are disabled", () =>
    Effect.gen(function*() {
      const slack = connector("slack")
      const subscription = yield* seed({ connector: slack.name }, slack)
      const connectors = yield* ConnectorRepository
      const target = yield* WakeTargetFake
      const intake = yield* SubscriptionIntake
      const values = { subscriptionAccess: "persisted-cache", messagePreviews: "enabled" }
      yield* connectors.storeValues(slack.name, values)
      const summary = 'Details for earlier message | Untrusted message excerpt: "fixture"'
      yield* intake.ingest(subscription.id, { _tag: "Event", event: { ...reported("post"), summary } })
      yield* target.failWith("unavailable")
      yield* TestClock.adjust("5 seconds")
      yield* deliverDue
      yield* connectors.storeValues(slack.name, { ...values, messagePreviews: "disabled" })
      yield* target.recover
      yield* TestClock.adjust("5 seconds")
      yield* deliverDue
      expect((yield* target.delivered)[0]?.pending[0]?.summary).toBe("Details for earlier message")
      expect((yield* eventsOf(subscription))[0]?.summary).toBe(summary)
    }).pipe(Effect.provide(layer)))

  it.effect("retries a failed wake with a doubling delay capped at the limit and raises no alert", () =>
    Effect.gen(function*() {
      const intake = yield* SubscriptionIntake
      const target = yield* WakeTargetFake
      const alerts = yield* AlertSinkFake
      const subscription = yield* seed()
      yield* target.failWith("session gone")
      yield* intake.ingest(subscription.id, { _tag: "Event", event: reported("a") })
      yield* TestClock.adjust("5 seconds")

      const delays: Array<number> = []
      for (let attempt = 0; attempt < 9; attempt++) {
        yield* deliverDue
        const now = yield* DateTime.now
        const [wake] = yield* wakesOf(subscription)
        const next = wake!.attempts.nextAttemptAt!
        delays.push(Duration.toSeconds(DateTime.distance(now, next)))
        yield* TestClock.setTime(DateTime.toEpochMillis(next))
      }

      expect(delays).toEqual([5, 10, 20, 40, 80, 160, 320, 600, 600])
      expect((yield* target.attempts).length).toBe(9)
      expect(yield* alerts.shown).toEqual([])
    }).pipe(Effect.provide(layer)))

  it.effect("sends the newer wake in place of a failing one", () =>
    Effect.gen(function*() {
      const intake = yield* SubscriptionIntake
      const target = yield* WakeTargetFake
      const subscription = yield* seed()
      yield* target.failWith("session gone")
      yield* intake.ingest(subscription.id, { _tag: "Event", event: reported("a") })
      yield* TestClock.adjust("5 seconds")
      yield* deliverDue

      yield* intake.ingest(subscription.id, { _tag: "End", reason: "closed" })
      yield* target.recover
      yield* deliverDue

      expect((yield* wakesOf(subscription)).map((wake) => [wake.reason, wake.state])).toEqual([
        ["events", "replaced"],
        ["ended", "delivered"]
      ])
      expect((yield* target.delivered).map((content) => content.why._tag)).toEqual(["Ended"])
    }).pipe(Effect.provide(layer)))

  it.effect("drops an events wake once its events are acknowledged", () =>
    Effect.gen(function*() {
      const intake = yield* SubscriptionIntake
      const target = yield* WakeTargetFake
      const subscriptions = yield* SubscriptionRepository
      const subscription = yield* seed()
      yield* intake.ingest(subscription.id, { _tag: "Event", event: reported("a") })
      yield* subscriptions.store({ ...(yield* reload(subscription)), ackedThrough: 1 })
      yield* TestClock.adjust("5 seconds")

      yield* deliverDue

      expect((yield* wakesOf(subscription)).map((wake) => wake.state)).toEqual(["dropped"])
      expect(yield* target.attempts).toEqual([])
    }).pipe(Effect.provide(layer)))
})
