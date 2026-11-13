import { describe, expect, it } from "@effect/vitest"
import { EventRepository, ConnectorRepository, SubscriptionRepository, WakeRepository } from "@exangelos/application"
import { Event, Ids, Connector, Session, Subscription, Wake } from "@exangelos/domain"
import { DateTime, Duration, Effect, Option } from "effect"
import type { Layer } from "effect"

export type Repositories =
  | ConnectorRepository.ConnectorRepository
  | SubscriptionRepository.SubscriptionRepository
  | EventRepository.EventRepository
  | WakeRepository.WakeRepository

export const at = (minutes: number) =>
  DateTime.add(DateTime.makeUnsafe("2026-11-12T10:00:00Z"), { minutes })

const you: Session.Actor = { _tag: "You" }
export const session: Session.Session = { harness: "t3", sessionId: "thread-1" }

export const connector = (name: string): Connector.Connector => ({
  name: Ids.ConnectorName.make(name),
  version: "1.0.0",
  origin: { _tag: "Official", version: "1.0.0" },
  digest: "sha256-abc",
  trust: "enabled",
  configuration: { _tag: "Set" },
  configuredBy: you,
  process: "stopped",
  unavailableSince: at(1)
})

export const subscription = (
  id: string,
  overrides: Partial<Subscription.Subscription> = {}
): Subscription.Subscription => ({
  id: Ids.SubscriptionId.make(id),
  connector: Ids.ConnectorName.make("github-pr"),
  parameters: { repository: "owner/repo", number: 7, nested: { draft: false } },
  subject: "owner/repo#7",
  label: "PR 7",
  intent: "Review when CI passes",
  wakeTarget: session,
  createdAt: at(0),
  expiresAt: at(7 * 24 * 60),
  state: { _tag: "Active" },
  stateSince: at(0),
  lastNumber: 0,
  ackedThrough: 0,
  eventAlerts: false,
  ...overrides
})

export const event = (sub: Subscription.Subscription, number: number, dedupeKey: string): Event.Event => ({
  id: Ids.EventId.make(`evt_${sub.id.slice(4)}${number}`),
  subscription: sub.id,
  number,
  type: Ids.EventType.make("check.completed"),
  occurredAt: at(number),
  receivedAt: at(number + 1),
  summary: `Event ${number}`,
  payload: { conclusion: "success", runs: [number, null], nested: { ok: true } },
  link: "https://example.com",
  dedupeKey
})

export const wake = (id: string, sub: Subscription.Subscription, minutes: number): Wake.Wake => ({
  id: Ids.WakeId.make(id),
  subscription: sub.id,
  reason: "events",
  through: 1,
  state: "waiting",
  attempts: { count: 0 },
  createdAt: at(minutes)
})

/**
 * One test body per repository rule, run against every implementation of the ports. Changes and
 * wakes come back in the order they were stored, which is what "oldest first" means for them.
 */
export const repositoryContract = (name: string, layer: () => Layer.Layer<Repositories, unknown>) =>
  describe(`${name} repositories`, () => {
    const test = (title: string, body: Effect.Effect<void, never, Repositories>) =>
      it.effect(title, () => Effect.provide(body, layer()).pipe(Effect.orDie))

    test(
      "connectors list by name, keep changes past removal and drop values with the connector",
      Effect.gen(function*() {
        const connectors = yield* ConnectorRepository.ConnectorRepository
        const name = Ids.ConnectorName.make("jira")
        const change = (kind: ConnectorRepository.ConnectorChangeKind, minutes: number): ConnectorRepository.ConnectorChange => ({
          connector: name,
          kind,
          actor: you,
          at: at(minutes)
        })
        yield* connectors.store(connector("jira"), change("import", 1))
        yield* connectors.store(connector("file-watch"))
        yield* connectors.store({ ...connector("jira"), trust: "inert" }, { ...change("disable", 2), detail: "by hand" })
        yield* connectors.storeValues(name, { site: "example.atlassian.net" })

        expect((yield* connectors.list).map((p) => p.name)).toEqual(["file-watch", "jira"])
        expect(yield* connectors.find(name)).toEqual(Option.some({ ...connector("jira"), trust: "inert" }))
        expect(yield* connectors.values(name)).toEqual({ site: "example.atlassian.net" })

        yield* connectors.remove(name, change("remove", 3))
        expect(yield* connectors.find(name)).toEqual(Option.none())
        expect(yield* connectors.values(name)).toEqual({})
        expect(yield* connectors.changes(name)).toEqual([
          change("import", 1),
          { ...change("disable", 2), detail: "by hand" },
          change("remove", 3)
        ])
      })
    )

    test(
      "subscriptions match every filter criterion and keep their changes",
      Effect.gen(function*() {
        const subscriptions = yield* SubscriptionRepository.SubscriptionRepository
        const newer = subscription("sub_b", { createdAt: at(5) })
        const older = subscription("sub_a", {
          createdAt: at(1),
          state: { _tag: "Paused", reason: { _tag: "BacklogAge", limit: Duration.hours(24) } }
        })
        const other = subscription("sub_c", {
          connector: Ids.ConnectorName.make("jira"),
          wakeTarget: { harness: "codex", sessionId: "thread-1" }
        })
        const created: Subscription.Change = { subscription: newer.id, kind: "create", actor: you, at: at(5) }
        yield* subscriptions.store(newer, created)
        yield* subscriptions.store(older)
        yield* subscriptions.store(other)
        yield* subscriptions.store({ ...newer, label: "renamed" }, { ...created, kind: "update", at: at(6) })

        const ids = (filter: SubscriptionRepository.Filter) =>
          Effect.map(subscriptions.list(filter), (list) => list.map((s) => s.id).sort())
        expect(yield* ids({})).toEqual(["sub_a", "sub_b", "sub_c"])
        expect(yield* ids({ states: ["Active"] })).toEqual(["sub_b", "sub_c"])
        expect(yield* ids({ states: [] })).toEqual([])
        expect(yield* ids({ connector: Ids.ConnectorName.make("github-pr"), target: session })).toEqual(["sub_a", "sub_b"])
        expect(yield* subscriptions.find(older.id)).toEqual(Option.some(older))
        expect(yield* subscriptions.find(newer.id)).toEqual(Option.some({ ...newer, label: "renamed" }))
        expect((yield* subscriptions.changes(newer.id)).map((c) => c.kind)).toEqual(["create", "update"])
      })
    )

    test(
      "subscriptions list oldest first by creation time",
      Effect.gen(function*() {
        const subscriptions = yield* SubscriptionRepository.SubscriptionRepository
        yield* subscriptions.store(subscription("sub_b", { createdAt: at(5) }))
        yield* subscriptions.store(subscription("sub_a", { createdAt: at(1) }))
        yield* subscriptions.store(subscription("sub_c", { createdAt: at(0) }))
        yield* subscriptions.store(subscription("sub_b", { createdAt: at(5), label: "renamed" }))
        expect((yield* subscriptions.list({})).map((s) => s.id)).toEqual(["sub_c", "sub_a", "sub_b"])
      })
    )

    test(
      "events come back by number, pending after the acknowledgement, and by dedupe key",
      Effect.gen(function*() {
        const repository = yield* EventRepository.EventRepository
        const subscriptions = yield* SubscriptionRepository.SubscriptionRepository
        const sub = subscription("sub_a")
        yield* repository.append({ ...sub, lastNumber: 2, cursor: "c2" }, [event(sub, 2, "k2"), event(sub, 1, "k1")])
        yield* repository.append(
          { ...sub, lastNumber: 3, ackedThrough: 1, cursor: "c3" },
          [event(sub, 3, "k3")]
        )
        yield* repository.append(subscription("sub_b"), [event(subscription("sub_b"), 1, "k1")])

        expect((yield* repository.list(sub.id)).map((e) => e.number)).toEqual([1, 2, 3])
        expect(yield* repository.list(sub.id, 1)).toEqual([event(sub, 2, "k2"), event(sub, 3, "k3")])
        expect(yield* subscriptions.find(sub.id)).toEqual(
          Option.some({ ...sub, lastNumber: 3, ackedThrough: 1, cursor: "c3" })
        )
        expect(yield* repository.findByDedupeKey(sub.id, "k2")).toEqual(Option.some(event(sub, 2, "k2")))
        expect(yield* repository.findByDedupeKey(sub.id, "k4")).toEqual(Option.none())
      })
    )

    test(
      "a new wake replaces the undelivered one and an update keeps attempts and the next attempt time",
      Effect.gen(function*() {
        const wakes = yield* WakeRepository.WakeRepository
        const sub = subscription("sub_a")
        const first = wake("wake_1", sub, 1)
        const second = wake("wake_2", sub, 2)
        const elsewhere = wake("wake_3", subscription("sub_b"), 3)
        yield* wakes.add(first)
        yield* wakes.add(elsewhere)
        yield* wakes.add(second)
        const retried: Wake.Wake = {
          ...second,
          state: "sending",
          attempts: { count: 2, lastError: "session busy", nextAttemptAt: at(12) }
        }
        yield* wakes.update(retried)

        expect(yield* wakes.list(sub.id)).toEqual([{ ...first, state: "replaced" }, retried])
        expect(yield* wakes.findUndelivered(sub.id)).toEqual(Option.some(retried))
        expect(yield* wakes.listUndelivered).toEqual([elsewhere, retried])

        yield* wakes.update({ ...retried, state: "delivered", attempts: { count: 3 } })
        expect(yield* wakes.findUndelivered(sub.id)).toEqual(Option.none())
      })
    )

    test(
      "removing closed subscriptions for retention deletes their changes, events and wakes only",
      Effect.gen(function*() {
        const subscriptions = yield* SubscriptionRepository.SubscriptionRepository
        const events = yield* EventRepository.EventRepository
        const wakes = yield* WakeRepository.WakeRepository
        const closed = subscription("sub_a", { state: { _tag: "Ended", reason: { _tag: "MaxEvents" } } })
        const kept = subscription("sub_b")
        for (const sub of [closed, kept]) {
          yield* subscriptions.store(sub, { subscription: sub.id, kind: "create", actor: you, at: at(0) })
          yield* events.append({ ...sub, lastNumber: 1 }, [event(sub, 1, "k1")])
          yield* wakes.add(wake(`wake_${sub.id.slice(4)}`, sub, 1))
        }
        const expired = yield* subscriptions.list({ states: ["Ended", "Cancelled"] })
        yield* subscriptions.remove(expired.map((s) => s.id))
        yield* subscriptions.remove([])

        expect(yield* subscriptions.find(closed.id)).toEqual(Option.none())
        expect(yield* subscriptions.changes(closed.id)).toEqual([])
        expect(yield* events.list(closed.id)).toEqual([])
        expect(yield* events.findByDedupeKey(closed.id, "k1")).toEqual(Option.none())
        expect(yield* wakes.list(closed.id)).toEqual([])
        expect((yield* subscriptions.list({})).map((s) => s.id)).toEqual([kept.id])
        expect(yield* events.list(kept.id)).toHaveLength(1)
        expect(yield* wakes.list(kept.id)).toHaveLength(1)
        expect(yield* subscriptions.changes(kept.id)).toHaveLength(1)
      })
    )
  })
