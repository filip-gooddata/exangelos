import { describe, expect, it } from "@effect/vitest"
import { Option, Result } from "effect"
import { Ids, Lifecycle } from "../src/index.ts"
import { alice, at, bob, later, limits, connector, start, subscription } from "./fixtures.ts"

const now = at("2026-11-02T10:00:00Z")
const byAlice = { _tag: "Session" as const, session: alice }
const byBob = { _tag: "Session" as const, session: bob }

const step = <A, E>(result: Result.Result<A, E>): A => Result.getOrThrow(result)

describe("Lifecycle", () => {
  it("(new) -> active: a subscribe call creates an active subscription without a wake", () => {
    const created = Lifecycle.create(
      {
        id: Ids.SubscriptionId.make("sub_7f3k"),
        connector: Ids.ConnectorName.make("github-pr"),
        parameters: { pr: "acme/app#123" },
        subject: "acme/app#123",
        label: "acme/app#123",
        intent: "Fix the build when CI fails",
        wakeTarget: Option.some(alice)
      },
      start,
      limits
    )
    expect(created).toMatchObject({ state: { _tag: "Active" }, lastNumber: 0, ackedThrough: 0, wakeTarget: alice })
  })

  it("rule 4: expiry is 7 days after the start, or sooner when asked for an end time, and once means one event", () => {
    const base = {
      id: Ids.SubscriptionId.make("sub_7f3k"),
      connector: Ids.ConnectorName.make("github-pr"),
      parameters: {},
      subject: "acme/app#123",
      label: "acme/app#123",
      intent: "Watch",
      wakeTarget: Option.none()
    }
    expect(Lifecycle.create(base, start, limits).expiresAt).toEqual(at("2026-11-08T10:00:00Z"))
    expect(
      Lifecycle.create({ ...base, endAt: at("2026-11-02T10:00:00Z") }, start, limits).expiresAt
    ).toEqual(at("2026-11-02T10:00:00Z"))
    expect(
      Lifecycle.create({ ...base, endAt: at("2026-12-01T10:00:00Z") }, start, limits).expiresAt
    ).toEqual(at("2026-11-08T10:00:00Z"))
    expect(Lifecycle.create({ ...base, once: true }, start, limits).maxEvents).toBe(1)
  })

  it("active -> paused (rule 13): the backlog reaching 20 events or 24 hours pauses with a wake", () => {
    const full = Lifecycle.backlog(subscription({ lastNumber: 20 }), Option.some(now), now, limits)
    expect(Option.getOrThrow(full).wake).toEqual(
      Option.some({ _tag: "Paused", reason: { _tag: "BacklogCount", limit: 20 } })
    )
    const old = Lifecycle.backlog(subscription({ lastNumber: 1 }), Option.some(start), later(start, "24 hours"), limits)
    expect(Option.getOrThrow(old).subscription.state).toEqual({
      _tag: "Paused",
      reason: { _tag: "BacklogAge", limit: limits.backlogAge }
    })
    expect(Lifecycle.backlog(subscription({ lastNumber: 19 }), Option.some(now), now, limits)).toEqual(Option.none())
  })

  it("active -> paused (rule 11): an actor's pause wakes the session unless the session paused it", () => {
    const byOther = step(Lifecycle.pause(subscription(), byBob, now))
    expect(byOther.subscription.state).toEqual({ _tag: "Paused", reason: { _tag: "Actor", actor: byBob } })
    expect(byOther.wake).toEqual(Option.some({ _tag: "Paused", reason: { _tag: "Actor", actor: byBob } }))
    expect(step(Lifecycle.pause(subscription(), byAlice, now)).wake).toEqual(Option.none())
  })

  it("paused, expired -> active (rule 14): resume sets a fresh expiry and refuses over the backlog limit", () => {
    const paused = subscription({ state: { _tag: "Paused", reason: { _tag: "Actor", actor: byBob } } })
    const resumed = step(Lifecycle.resume(paused, Option.none(), now, limits))
    expect(resumed.subscription).toMatchObject({ state: { _tag: "Active" }, expiresAt: later(now, "7 days") })
    expect(resumed.wake).toEqual(Option.none())

    const expired = subscription({ state: { _tag: "Expired" }, lastNumber: 20 })
    const refused = Lifecycle.resume(expired, Option.some(now), now, limits)
    expect(Result.isFailure(refused) && refused.failure).toMatchObject({
      _tag: "BacklogOverLimit",
      pending: 20,
      through: 20
    })
  })

  it("active -> expired: passing the expiry time wakes with the resume command", () => {
    const expired = Lifecycle.expire(subscription(), later(start, "7 days"))
    expect(Option.getOrThrow(expired).subscription.state).toEqual({ _tag: "Expired" })
    expect(Option.getOrThrow(expired).wake).toEqual(Option.some({ _tag: "Expired" }))
    expect(Lifecycle.expire(subscription(), now)).toEqual(Option.none())
  })

  it("paused -> expired: passing the expiry time sends no second wake", () => {
    const paused = subscription({ state: { _tag: "Paused", reason: { _tag: "BacklogCount", limit: 20 } } })
    const expired = Option.getOrThrow(Lifecycle.expire(paused, later(start, "8 days")))
    expect(expired.subscription.state).toEqual({ _tag: "Expired" })
    expect(expired.wake).toEqual(Option.none())
  })

  it("active -> ended: the connector ending it wakes with the reason", () => {
    const ended = step(Lifecycle.end(subscription(), { _tag: "Connector", reason: "PR merged" }, now))
    expect(ended.subscription.state).toEqual({ _tag: "Ended", reason: { _tag: "Connector", reason: "PR merged" } })
    expect(ended.wake).toEqual(Option.some({ _tag: "Ended", reason: { _tag: "Connector", reason: "PR merged" } }))
  })

  it("any open -> cancelled: a cancel wakes the session unless the session cancelled it", () => {
    const paused = subscription({ state: { _tag: "Paused", reason: { _tag: "BacklogCount", limit: 20 } } })
    expect(step(Lifecycle.cancel(paused, { _tag: "You" }, now)).wake).toEqual(
      Option.some({ _tag: "Cancelled", actor: { _tag: "You" } })
    )
    expect(step(Lifecycle.cancel(subscription(), byAlice, now)).wake).toEqual(Option.none())
    expect(Result.isFailure(Lifecycle.cancel(subscription({ state: { _tag: "Expired" } }), byAlice, now))).toBe(false)
    expect(
      Result.isFailure(Lifecycle.cancel(subscription({ state: { _tag: "Cancelled", actor: byAlice } }), byBob, now))
    ).toBe(true)
  })

  it("active -> active: a connector unavailable for 1 hour wakes its sessions once", () => {
    const down = connector({ process: "failing", unavailableSince: start })
    expect(Lifecycle.suspensionWake(subscription(), down, Option.none(), later(start, "59 minutes"), limits)).toEqual(
      Option.none()
    )
    expect(Lifecycle.suspensionWake(subscription(), down, Option.none(), later(start, "1 hour"), limits)).toEqual(
      Option.some({ _tag: "Suspended", since: start, problem: "it keeps failing" })
    )
    expect(
      Lifecycle.suspensionWake(subscription(), down, Option.some(later(start, "1 hour")), later(start, "2 hours"), limits)
    ).toEqual(Option.none())
  })

  it("active -> active: a removed connector's outage wakes its sessions once after 1 hour", () => {
    const outage = Option.some({ since: start, problem: "it was removed" })
    expect(Lifecycle.isSuspendedWhen(subscription(), false)).toBe(true)
    expect(Lifecycle.suspensionWakeWhen(subscription(), outage, Option.none(), later(start, "59 minutes"), limits))
      .toEqual(Option.none())
    expect(Lifecycle.suspensionWakeWhen(subscription(), outage, Option.none(), later(start, "1 hour"), limits)).toEqual(
      Option.some({ _tag: "Suspended", since: start, problem: "it was removed" })
    )
  })

  it("rule 15: only an active subscription with an available connector is watched", () => {
    expect(Lifecycle.isWatched(subscription(), connector())).toBe(true)
    expect(Lifecycle.isWatched(subscription({ state: { _tag: "Expired" } }), connector())).toBe(false)
    expect(Lifecycle.isWatched(subscription(), connector({ trust: "inert" }))).toBe(false)
  })
})
