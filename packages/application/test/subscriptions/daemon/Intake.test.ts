import { describe, expect, it } from "@effect/vitest"
import { DateTime, Effect } from "effect"
import { Ids } from "@exangelos/domain"
import { AlertSinkFake, PluginAccessFake, WakeTargetFake } from "@exangelos/application/testing"
import { TestClock } from "effect/testing"
import { PluginRepository } from "../../../src/ports/PluginRepository.ts"
import { SubscriptionIntake } from "../../../src/seam/SubscriptionIntake.ts"
import { deliverDue } from "../../../src/subscriptions/daemon/Delivery.ts"
import { plugin } from "../../fixtures.ts"
import { eventsOf, github, layer, reload, reported, seed, wakesOf } from "./support.ts"

const pendingNumbers = Effect.gen(function*() {
  const target = yield* WakeTargetFake
  return (yield* target.delivered).map((content) => content.pending.map((line) => line.number))
})

describe("SubscriptionIntake", () => {
  it.effect("keeps new selected events with their cursor and wakes once per window", () =>
    Effect.gen(function*() {
      const intake = yield* SubscriptionIntake
      const subscription = yield* seed({ eventTypes: [Ids.EventType.make("tick")] })

      yield* intake.ingest(subscription.id, { _tag: "Event", event: reported("a"), cursor: "c1" })
      yield* intake.ingest(subscription.id, { _tag: "Event", event: reported("a") })
      yield* intake.ingest(subscription.id, { _tag: "Event", event: reported("b", "other") })
      yield* intake.ingest(subscription.id, { _tag: "Event", event: reported("c"), cursor: "c2" })

      expect((yield* eventsOf(subscription)).map((event) => [event.number, event.dedupeKey])).toEqual([[1, "a"], [2, "c"]])
      expect((yield* reload(subscription)).cursor).toBe("c2")

      yield* deliverDue
      expect(yield* pendingNumbers).toEqual([])
      yield* TestClock.adjust("5 seconds")
      yield* deliverDue
      expect(yield* pendingNumbers).toEqual([[1, 2]])

      yield* intake.ingest(subscription.id, { _tag: "Event", event: reported("d") })
      yield* deliverDue
      expect(yield* pendingNumbers).toEqual([[1, 2], [1, 2, 3]])
    }).pipe(Effect.provide(layer)))

  it.effect("raises an event alert for a subscription with event alerts on while they are off globally", () =>
    Effect.gen(function*() {
      const intake = yield* SubscriptionIntake
      const alerted = yield* seed({ eventAlerts: true })
      const quiet = yield* seed()

      yield* intake.ingest(alerted.id, { _tag: "Event", event: reported("a") })
      yield* intake.ingest(quiet.id, { _tag: "Event", event: reported("b") })

      const shown = yield* (yield* AlertSinkFake).shown
      expect(shown.map((alert) => alert._tag === "Event" ? [alert.subscription, alert.event.dedupeKey] : alert._tag))
        .toEqual([[alerted.id, "a"]])
    }).pipe(Effect.provide(layer)))

  it.effect("pauses at the backlog count with one paused wake and stops the stream", () =>
    Effect.gen(function*() {
      const intake = yield* SubscriptionIntake
      const access = yield* PluginAccessFake
      const subscription = yield* seed()

      const verdicts: Array<string> = []
      for (let index = 1; index <= 20; index++) {
        verdicts.push(yield* intake.ingest(subscription.id, { _tag: "Event", event: reported(`k${index}`) }))
      }

      expect(verdicts.filter((verdict) => verdict === "stop")).toHaveLength(1)
      expect(verdicts.at(-1)).toBe("stop")
      expect((yield* reload(subscription)).state).toEqual({
        _tag: "Paused",
        reason: { _tag: "BacklogCount", limit: 20 }
      })
      const undelivered = (yield* wakesOf(subscription)).filter((wake) => wake.state === "waiting")
      expect(undelivered.map((wake) => wake.reason)).toEqual(["paused"])
      expect(yield* access.watched).not.toContain(subscription.id)
    }).pipe(Effect.provide(layer)))

  it.effect("ends at max events and on an End item with one ended wake", () =>
    Effect.gen(function*() {
      const intake = yield* SubscriptionIntake
      const capped = yield* seed({ maxEvents: 2 })
      const ending = yield* seed()

      expect(yield* intake.ingest(capped.id, { _tag: "Event", event: reported("a") })).toBe("continue")
      expect(yield* intake.ingest(capped.id, { _tag: "Event", event: reported("b") })).toBe("stop")
      expect(yield* intake.ingest(ending.id, { _tag: "End", reason: "the repository was deleted" })).toBe("stop")

      expect((yield* reload(capped)).state).toEqual({ _tag: "Ended", reason: { _tag: "MaxEvents" } })
      expect((yield* reload(ending)).state).toEqual({
        _tag: "Ended",
        reason: { _tag: "Plugin", reason: "the repository was deleted" }
      })
      for (const subscription of [capped, ending]) {
        const undelivered = (yield* wakesOf(subscription)).filter((wake) => wake.state === "waiting")
        expect(undelivered.map((wake) => wake.reason)).toEqual(["ended"])
      }
    }).pipe(Effect.provide(layer)))

  it.effect("sends one suspended wake once the plugin has been unavailable an hour, and drops it on return", () =>
    Effect.gen(function*() {
      const intake = yield* SubscriptionIntake
      const since = yield* DateTime.now
      const failing = { ...plugin("github"), process: "failing" as const, unavailableSince: since }
      const first = yield* seed({}, failing)
      const second = yield* seed({}, failing)

      yield* intake.pluginChanged(failing)
      expect(yield* wakesOf(first)).toEqual([])

      yield* TestClock.adjust("1 hour")
      yield* intake.pluginChanged(failing)
      yield* intake.pluginChanged(failing)
      for (const subscription of [first, second]) {
        expect((yield* wakesOf(subscription)).map((wake) => [wake.reason, wake.state])).toEqual([["suspended", "waiting"]])
      }

      yield* intake.pluginChanged(plugin("github"))
      expect((yield* wakesOf(first)).map((wake) => wake.state)).toEqual(["dropped"])
    }).pipe(Effect.provide(layer)))

  it.effect("still sends event wakes for a removed plugin and one suspended wake after an hour", () =>
    Effect.gen(function*() {
      const intake = yield* SubscriptionIntake
      const plugins = yield* PluginRepository
      const target = yield* WakeTargetFake
      const subscription = yield* seed()
      yield* intake.ingest(subscription.id, { _tag: "Event", event: reported("a") })
      const since = yield* DateTime.now
      yield* plugins.remove(github, { plugin: github, kind: "remove", actor: { _tag: "You" }, at: since })
      yield* intake.pluginRemoved(github, since, "it was removed")

      yield* TestClock.adjust("5 seconds")
      yield* deliverDue
      yield* TestClock.adjust("1 hour")
      yield* intake.pluginRemoved(github, since, "it was removed")
      yield* intake.pluginRemoved(github, since, "it was removed")
      yield* deliverDue
      yield* intake.pluginRemoved(github, since, "it was removed")

      expect((yield* wakesOf(subscription)).map((wake) => [wake.reason, wake.state])).toEqual([
        ["events", "delivered"],
        ["suspended", "delivered"]
      ])
      expect((yield* target.delivered).map((content) => content.why)).toEqual([
        { _tag: "Events" },
        { _tag: "Suspended", since, problem: "it was removed" }
      ])
    }).pipe(Effect.provide(layer)))
})
