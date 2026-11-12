import { describe, expect, it } from "@effect/vitest"
import { DateTime, Effect, Exit, Fiber, Option, Stream } from "effect"
import { Event, Ids, Session, Subscription, Wake } from "@exangelos/domain"
import {
  EventRepository,
  PluginDirectory,
  PluginImportSource,
  PluginRuntime,
  SubscriptionRepository,
  WakeRepository,
  WakeTarget
} from "@exangelos/application"
import {
  layerPluginFiles,
  layerPluginRuntime,
  layerRepositories,
  layerWakeTarget,
  PluginFilesFake,
  PluginRuntimeFake,
  WakeTargetFake
} from "@exangelos/application/testing"
import { catalogue } from "./fixtures.ts"

const at = DateTime.makeUnsafe("2026-11-12T10:00:00Z")
const id = Ids.SubscriptionId.make("sub_abc")
const name = Ids.PluginName.make("template")
const session: Session.Session = { harness: "t3", sessionId: "thread-1" }

const subscription: Subscription.Subscription = {
  id,
  plugin: name,
  parameters: { name: "x" },
  subject: "x",
  label: "x",
  intent: "watch x",
  wakeTarget: session,
  createdAt: at,
  expiresAt: at,
  state: { _tag: "Active" },
  stateSince: at,
  lastNumber: 0,
  ackedThrough: 0,
  eventAlerts: false
}

const event: Event.Event = {
  id: Ids.EventId.make("evt_1"),
  subscription: id,
  number: 1,
  type: Ids.EventType.make("tick"),
  occurredAt: at,
  receivedAt: at,
  summary: "tick",
  payload: {},
  dedupeKey: "tick-1"
}

const wake = (wakeId: string): Wake.Wake => ({
  id: Ids.WakeId.make(wakeId),
  subscription: id,
  reason: "events",
  through: 1,
  state: "waiting",
  attempts: { count: 0 },
  createdAt: at
})

const content: Wake.WakeContent = { subscription: id, plugin: "template", subject: "x", why: { _tag: "Events" }, pending: [] }

describe("in-memory repositories", () => {
  it.effect("keep at most one undelivered wake and delete a subscription with its records", () =>
    Effect.gen(function*() {
      const subscriptions = yield* SubscriptionRepository.SubscriptionRepository
      const events = yield* EventRepository.EventRepository
      const wakes = yield* WakeRepository.WakeRepository
      yield* events.append({ ...subscription, lastNumber: 1, cursor: "c1" }, [event])
      yield* wakes.add(wake("wake_a"))
      yield* wakes.add(wake("wake_b"))

      expect((yield* wakes.list(id)).map((w) => [w.id, w.state])).toEqual([["wake_a", "replaced"], ["wake_b", "waiting"]])
      expect(Option.map(yield* subscriptions.find(id), (s) => s.cursor)).toEqual(Option.some("c1"))
      expect(Option.isSome(yield* events.findByDedupeKey(id, "tick-1"))).toBe(true)

      yield* subscriptions.remove([id])

      expect(yield* subscriptions.find(id)).toEqual(Option.none())
      expect(yield* events.list(id)).toEqual([])
      expect(yield* wakes.list(id)).toEqual([])
    }).pipe(Effect.provide(layerRepositories)))
})

describe("PluginRuntimeFake", () => {
  it.effect("streams scripted items and fails the stream when the plugin crashes", () =>
    Effect.scoped(Effect.gen(function*() {
      const runtime = yield* PluginRuntime.PluginRuntime
      const fake = yield* PluginRuntimeFake
      yield* fake.define(name, { catalogue })
      yield* fake.emit(name, { _tag: "Cursor", cursor: "c1" })

      const process = yield* runtime.start({ name, directory: "/plugins/template", entry: { _tag: "Bundle", path: "main.js" }, dev: false })
      const items = yield* Stream.runCollect(process.watch({ parameters: { name: "x" }, eventTypes: [] })).pipe(Effect.forkChild)
      yield* Effect.yieldNow
      yield* fake.crash(name, "killed")

      const exit = yield* Fiber.await(items)
      expect(Exit.isFailure(exit)).toBe(true)
      expect((yield* process.exited).reason).toBe("killed")
      expect((yield* fake.watches(name)).length).toBe(1)
    })).pipe(Effect.provide(layerPluginRuntime)))
})

describe("WakeTargetFake", () => {
  it.effect("records failed attempts until it recovers", () =>
    Effect.gen(function*() {
      const target = yield* WakeTarget.WakeTarget
      const fake = yield* WakeTargetFake
      yield* fake.failWith("thread gone")

      const failed = yield* Effect.flip(target.deliver(session, content))
      yield* fake.recover
      yield* target.deliver(session, content)

      expect(failed.reason).toBe("thread gone")
      expect((yield* fake.attempts).map((a) => a.failure)).toEqual(["thread gone", undefined])
      expect(yield* fake.delivered).toEqual([content])
    }).pipe(Effect.provide(layerWakeTarget)))
})

describe("PluginFilesFake", () => {
  it.effect("lists an imported plugin and reports a change to its files", () =>
    Effect.gen(function*() {
      const directory = yield* PluginDirectory.PluginDirectory
      const importer = yield* PluginImportSource.PluginImportSource
      const fake = yield* PluginFilesFake
      const source = { _tag: "Directory", path: "/src/template" } as const
      yield* fake.offer(source, { name, version: "1.0.0", directory: "/src/template", entry: { _tag: "Bundle", path: "main.js" }, digest: "d1" })

      const placed = yield* importer.place(source)
      const changed = yield* directory.changes(placed).pipe(Stream.take(1), Stream.runDrain, Effect.forkChild)
      yield* Effect.yieldNow
      yield* fake.edit(placed, "d2")
      yield* Fiber.join(changed)

      expect((yield* directory.list).map((p) => p.name)).toEqual(["template"])
      expect((yield* directory.read(placed)).digest).toBe("d2")
    }).pipe(Effect.provide(layerPluginFiles([]))))
})
