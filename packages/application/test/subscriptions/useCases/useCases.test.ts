import { describe, expect, it } from "@effect/vitest"
import { DateTime, Duration, Effect, Fiber, Option, Result } from "effect"
import { TestClock } from "effect/testing"
import { Ids } from "@exangelos/domain"
import type { Catalogue, Event, Session, Subscription } from "@exangelos/domain"
import { ConnectorAccessFake } from "@exangelos/application/testing"
import { ConnectorRepository } from "../../../src/ports/ConnectorRepository.ts"
import { SubscriptionIntake } from "../../../src/seam/SubscriptionIntake.ts"
import { type Filter, SubscriptionRepository } from "../../../src/ports/SubscriptionRepository.ts"
import { WakeRepository } from "../../../src/ports/WakeRepository.ts"
import { commit } from "../../../src/subscriptions/Transitions.ts"
import {
  acknowledge,
  cancel,
  pause,
  resume,
  retarget,
  setEventAlerts,
  subscribe,
  type SubscribeRequest,
  update,
  wait
} from "../../../src/subscriptions/useCases/index.ts"
import { catalogue, connector } from "../../fixtures.ts"
import { layer as layerWithIntake } from "../daemon/support.ts"
import { layerHarness } from "../harness.ts"

const own: Session.Session = { harness: "t3", sessionId: "own" }
const other: Session.Session = { harness: "codex", sessionId: "other" }
const ownActor: Session.Actor = { _tag: "Session", session: own }
const otherActor: Session.Actor = { _tag: "Session", session: other }
const prs = Ids.ConnectorName.make("github-pr")

const setup = Effect.gen(function*() {
  yield* (yield* ConnectorRepository).store(connector("github-pr"))
  yield* (yield* ConnectorAccessFake).define(prs, {
    catalogue,
    describe: (parameters: Catalogue.Parameters) =>
      Effect.succeed({ catalogue, parameters, subject: `pr ${String(parameters.pr)}`, label: "PR" })
  })
})

const request = (overrides: Partial<SubscribeRequest> = {}): SubscribeRequest => ({
  connector: prs,
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
      expect(yield* (yield* ConnectorAccessFake).watched).toEqual([subscription.id])
      const changes = yield* (yield* SubscriptionRepository).changes(subscription.id)
      expect(changes.map((change) => [change.kind, change.actor])).toEqual([["create", ownActor]])
    }).pipe(Effect.provide(layerHarness)))

  it.effect("subscribe refuses a harness you have not defined", () =>
    Effect.gen(function*() {
      yield* setup
      const named = { harness: "relay", sessionId: "s1" } as Session.Target
      const refused = yield* Effect.flip(subscribe(ownActor, request({ target: { _tag: "Session", session: named } }), [own]))
      expect(refused._tag).toBe("UnknownHarness")
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

  it.effect("concurrent subscribes from one session store one subscription and refuse the other as similar", () =>
    Effect.gen(function*() {
      yield* setup
      const repository = yield* SubscriptionRepository
      const slowList = { ...repository, list: (filter: Filter) => Effect.tap(repository.list(filter), () => Effect.yieldNow) }
      const attempt = Effect.result(
        Effect.provideService(subscribe(ownActor, request(), [own]), SubscriptionRepository, slowList)
      )

      const outcomes = yield* Effect.all([attempt, attempt], { concurrency: 2 })

      const created = outcomes.filter(Result.isSuccess).map((outcome) => outcome.success)
      const refused = outcomes.filter(Result.isFailure).map((outcome) => outcome.failure)
      expect(created).toHaveLength(1)
      expect(refused).toMatchObject([{ _tag: "SimilarSubscriptions", matches: [{ id: created[0]!.id }] }])
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

  it.effect("wait reports a connector outage that began while waiting once it lasted long enough", () =>
    Effect.gen(function*() {
      const subscription = yield* subscribed({ target: { _tag: "PullOnly" } })
      const waiting = yield* Effect.forkChild(wait(ownActor, { id: subscription.id }))
      yield* TestClock.adjust(Duration.minutes(5))
      yield* (yield* ConnectorRepository).store({ ...connector("github-pr"), process: "failing", unavailableSince: yield* DateTime.now })
      yield* TestClock.adjust(Duration.minutes(30))
      expect(waiting.pollUnsafe()).toBeUndefined()
      yield* TestClock.adjust(Duration.minutes(31))

      expect((yield* Fiber.join(waiting)).why).toMatchObject({ _tag: "Suspended", problem: "it keeps failing" })
    }).pipe(Effect.provide(layerHarness)))

  it.effect("wait reports a removed connector once it has been gone long enough", () =>
    Effect.gen(function*() {
      const subscription = yield* subscribed({ target: { _tag: "PullOnly" } })
      const now = yield* DateTime.now
      yield* (yield* SubscriptionIntake).connectorRemoved(prs, now, "the connector was removed")
      yield* (yield* ConnectorRepository).remove(prs, { connector: prs, kind: "remove", actor: ownActor, at: now })
      const waiting = yield* Effect.forkChild(wait(ownActor, { id: subscription.id }))
      yield* TestClock.adjust(Duration.minutes(59))
      expect(waiting.pollUnsafe()).toBeUndefined()
      yield* TestClock.adjust(Duration.minutes(2))

      expect((yield* Fiber.join(waiting)).why).toMatchObject({ _tag: "Suspended", problem: "the connector was removed" })
    }).pipe(Effect.provide(layerWithIntake)))

  it.effect("you and the creating session switch event alerts, even after it wakes another session that is refused", () =>
    Effect.gen(function*() {
      const subscription = yield* subscribed()
      const you: Session.Actor = { _tag: "You" }
      yield* retarget(ownActor, { id: subscription.id, target: { _tag: "Session", session: other } }, [own, other])

      expect((yield* setEventAlerts(you, { id: subscription.id, eventAlerts: true })).eventAlerts).toBe(true)
      expect((yield* setEventAlerts(ownActor, { id: subscription.id, eventAlerts: false })).eventAlerts).toBe(false)
      const refused = yield* Effect.flip(setEventAlerts(otherActor, { id: subscription.id, eventAlerts: true }))

      expect(refused).toMatchObject({ _tag: "HumanRequired", subscription: subscription.id })
      const changes = yield* (yield* SubscriptionRepository).changes(subscription.id)
      expect(changes.filter((change) => change.kind === "eventAlerts").map((change) => [change.actor, change.detail]))
        .toEqual([[you, "on"], [ownActor, "off"]])
      expect(Option.map(yield* (yield* SubscriptionRepository).find(subscription.id), (found) => found.eventAlerts))
        .toEqual(Option.some(false))
    }).pipe(Effect.provide(layerHarness)))

  it.effect("pause by the own session stores no wake; by another actor it stores a paused wake", () =>
    Effect.gen(function*() {
      const mine = yield* subscribed()
      const theirs = yield* subscribe(ownActor, request({ parameters: { pr: 8 } }), [own])

      yield* pause(ownActor, { id: mine.id })
      yield* pause(otherActor, { id: theirs.id })

      expect(yield* wakeReasons(mine.id)).toEqual([])
      expect(yield* wakeReasons(theirs.id)).toEqual(["paused"])
      expect(yield* (yield* ConnectorAccessFake).watched).toEqual([])
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
      expect(yield* (yield* ConnectorAccessFake).watched).toEqual([subscription.id])
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

  it.effect("update is refused when the connector reports another subject", () =>
    Effect.gen(function*() {
      const subscription = yield* subscribed()

      const refused = yield* Effect.flip(update(ownActor, { id: subscription.id, parameters: { pr: 9 } }))

      expect(refused).toMatchObject({ _tag: "SubjectChanged", subject: "pr 7", reported: "pr 9" })
    }).pipe(Effect.provide(layerHarness)))
})
