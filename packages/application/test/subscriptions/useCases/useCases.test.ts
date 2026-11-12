import { describe, expect, it } from "@effect/vitest"
import { DateTime, Duration, Effect, Fiber, Option } from "effect"
import { TestClock } from "effect/testing"
import { Ids } from "@exangelos/domain"
import type { Catalogue, Event, Session, Subscription } from "@exangelos/domain"
import { PluginAccessFake } from "@exangelos/application/testing"
import { PluginRepository } from "../../../src/ports/PluginRepository.ts"
import { SubscriptionRepository } from "../../../src/ports/SubscriptionRepository.ts"
import { WakeRepository } from "../../../src/ports/WakeRepository.ts"
import { commit } from "../../../src/subscriptions/Transitions.ts"
import {
  acknowledge,
  cancel,
  pause,
  resume,
  subscribe,
  type SubscribeRequest,
  update,
  wait
} from "../../../src/subscriptions/useCases/index.ts"
import { catalogue, plugin } from "../../fixtures.ts"
import { layerHarness } from "../harness.ts"

const own: Session.Session = { harness: "t3", sessionId: "own" }
const other: Session.Session = { harness: "codex", sessionId: "other" }
const ownActor: Session.Actor = { _tag: "Session", session: own }
const otherActor: Session.Actor = { _tag: "Session", session: other }
const prs = Ids.PluginName.make("github-pr")

const setup = Effect.gen(function*() {
  yield* (yield* PluginRepository).store(plugin("github-pr"))
  yield* (yield* PluginAccessFake).define(prs, {
    catalogue,
    describe: (parameters: Catalogue.Parameters) =>
      Effect.succeed({ catalogue, parameters, subject: `pr ${String(parameters.pr)}`, label: "PR" })
  })
})

const request = (overrides: Partial<SubscribeRequest> = {}): SubscribeRequest => ({
  plugin: prs,
  parameters: { pr: 7 },
  intent: "Merge once CI is green",
  target: { _tag: "Caller" },
  similarOk: [],
  ...overrides
})

const subscribed = (overrides: Partial<SubscribeRequest> = {}) =>
  Effect.andThen(setup, subscribe(ownActor, request(overrides), [own]))

const withEvents = (subscription: Subscription.Subscription, count: number) =>
  Effect.gen(function*() {
    const now = yield* DateTime.now
    const events: Array<Event.Event> = Array.from({ length: count }, (_, index) => {
      const number = subscription.lastNumber + index + 1
      return {
        id: Ids.EventId.make(`evt_${number}`),
        subscription: subscription.id,
        number: number,
        type: Ids.EventType.make("tick"),
        occurredAt: now,
        receivedAt: now,
        summary: `tick ${number}`,
        payload: {},
        dedupeKey: `tick-${number}`
      }
    })
    const updated = { ...subscription, lastNumber: subscription.lastNumber + count }
    yield* commit(Option.some(subscription), { subscription: updated, wake: Option.none(), events })
    return updated
  })

const stored = (id: Ids.SubscriptionId) =>
  Effect.gen(function*() {
    return Option.getOrThrow(yield* (yield* SubscriptionRepository).find(id))
  })

const wakeReasons = (id: Ids.SubscriptionId) =>
  Effect.gen(function*() {
    return (yield* (yield* WakeRepository).list(id)).map((wake) => wake.reason)
  })

describe("subscription use cases", () => {
  it.effect("subscribe stores an active subscription, watches it and records the create", () =>
    Effect.gen(function*() {
      const subscription = yield* subscribed()

      expect(yield* stored(subscription.id)).toMatchObject({
        state: { _tag: "Active" },
        intent: "Merge once CI is green",
        wakeTarget: own,
        subject: "pr 7"
      })
      expect(yield* (yield* PluginAccessFake).watched).toEqual([subscription.id])
      const changes = yield* (yield* SubscriptionRepository).changes(subscription.id)
      expect(changes.map((change) => [change.kind, change.actor])).toEqual([["create", ownActor]])
    }).pipe(Effect.provide(layerHarness)))

  it.effect("subscribe refuses a similar open subscription of the same session until its id is resubmitted", () =>
    Effect.gen(function*() {
      const first = yield* subscribed()

      const refused = yield* Effect.flip(subscribe(ownActor, request({ parameters: { pr: 7, draft: true } }), [own]))
      expect(refused).toMatchObject({ _tag: "SimilarSubscriptions", matches: [{ id: first.id, parameters: { pr: 7 } }] })

      const second = yield* subscribe(ownActor, request({ similarOk: [first.id] }), [own])
      expect(second.id).not.toEqual(first.id)

      const elsewhere = yield* subscribe(otherActor, request(), [other])
      expect(elsewhere.wakeTarget).toEqual(other)
    }).pipe(Effect.provide(layerHarness)))

  it.effect("acknowledge moves ackedThrough up to the last number and never back", () =>
    Effect.gen(function*() {
      const subscription = yield* withEvents(yield* subscribed(), 3)

      expect((yield* acknowledge(ownActor, { id: subscription.id, through: 2 })).ackedThrough)
        .toBe(2)
      expect((yield* acknowledge(ownActor, { id: subscription.id, through: 9 })).ackedThrough)
        .toBe(3)
      expect((yield* acknowledge(ownActor, { id: subscription.id, through: 1 })).ackedThrough)
        .toBe(3)
      const changes = yield* (yield* SubscriptionRepository).changes(subscription.id)
      expect(changes.filter((change) => change.kind === "ack")).toHaveLength(3)
    }).pipe(Effect.provide(layerHarness)))

  it.effect("wait on a pull-only subscription returns pending events at once, else blocks until one arrives", () =>
    Effect.gen(function*() {
      const subscription = yield* subscribed({ target: { _tag: "PullOnly" } })

      const waiting = yield* Effect.forkChild(wait(ownActor, { id: subscription.id }))
      yield* TestClock.adjust(Duration.minutes(1))
      expect(waiting.pollUnsafe()).toBeUndefined()

      yield* withEvents(subscription, 1)
      const content = yield* Fiber.join(waiting)
      expect(content).toMatchObject({
        subscription: subscription.id,
        why: { _tag: "Events" },
        pending: [{ number: 1, type: "tick", summary: "tick 1" }]
      })

      expect((yield* wait(ownActor, { id: subscription.id })).pending).toHaveLength(1)
      expect(yield* wakeReasons(subscription.id)).toEqual([])
    }).pipe(Effect.provide(layerHarness)))

  it.effect("wait reports a plugin outage that began while waiting once it lasted long enough", () =>
    Effect.gen(function*() {
      const subscription = yield* subscribed({ target: { _tag: "PullOnly" } })
      const waiting = yield* Effect.forkChild(wait(ownActor, { id: subscription.id }))
      yield* TestClock.adjust(Duration.minutes(5))
      yield* (yield* PluginRepository).store({ ...plugin("github-pr"), process: "failing", unavailableSince: yield* DateTime.now })
      yield* TestClock.adjust(Duration.minutes(30))
      expect(waiting.pollUnsafe()).toBeUndefined()
      yield* TestClock.adjust(Duration.minutes(31))

      expect((yield* Fiber.join(waiting)).why).toMatchObject({ _tag: "Suspended", problem: "it keeps failing" })
    }).pipe(Effect.provide(layerHarness)))

  it.effect("pause by the own session stores no wake; by another actor it stores a paused wake", () =>
    Effect.gen(function*() {
      const mine = yield* subscribed()
      const theirs = yield* subscribe(ownActor, request({ parameters: { pr: 8 } }), [own])

      yield* pause(ownActor, { id: mine.id })
      yield* pause(otherActor, { id: theirs.id })

      expect(yield* wakeReasons(mine.id)).toEqual([])
      expect(yield* wakeReasons(theirs.id)).toEqual(["paused"])
      expect(yield* (yield* PluginAccessFake).watched).toEqual([])
    }).pipe(Effect.provide(layerHarness)))

  it.effect("resume sets a fresh expiry and watches again from the kept cursor", () =>
    Effect.gen(function*() {
      const subscription = yield* subscribed()
      yield* (yield* SubscriptionRepository).store({ ...subscription, cursor: "c-41" })
      yield* pause(ownActor, { id: subscription.id })
      yield* TestClock.adjust(Duration.days(2))

      const resumed = yield* resume(ownActor, { id: subscription.id })

      const now = yield* DateTime.now
      expect(resumed.state._tag).toBe("Active")
      expect(resumed.cursor).toBe("c-41")
      expect(resumed.expiresAt).toEqual(DateTime.addDuration(now, Duration.days(7)))
      expect(yield* (yield* PluginAccessFake).watched).toEqual([subscription.id])
    }).pipe(Effect.provide(layerHarness)))

  it.effect("resume is refused while the backlog is over the limit", () =>
    Effect.gen(function*() {
      const subscription = yield* withEvents(yield* subscribed(), 20)
      yield* pause(ownActor, { id: subscription.id })

      const refused = yield* Effect.flip(resume(ownActor, { id: subscription.id }))

      expect(refused).toMatchObject({ _tag: "BacklogOverLimit", pending: 20, through: 20 })
    }).pipe(Effect.provide(layerHarness)))

  it.effect("cancel by another actor stores a cancelled wake; by the own session none", () =>
    Effect.gen(function*() {
      const mine = yield* subscribed()
      const theirs = yield* subscribe(ownActor, request({ parameters: { pr: 8 } }), [own])

      yield* cancel(ownActor, { id: mine.id })
      yield* cancel(otherActor, { id: theirs.id })

      expect(yield* wakeReasons(mine.id)).toEqual([])
      expect(yield* wakeReasons(theirs.id)).toEqual(["cancelled"])
    }).pipe(Effect.provide(layerHarness)))

  it.effect("update is refused when the plugin reports another subject", () =>
    Effect.gen(function*() {
      const subscription = yield* subscribed()

      const refused = yield* Effect.flip(update(ownActor, { id: subscription.id, parameters: { pr: 9 } }))

      expect(refused).toMatchObject({ _tag: "SubjectChanged", subject: "pr 7", reported: "pr 9" })
    }).pipe(Effect.provide(layerHarness)))
})
