import { describe, expect, it } from "@effect/vitest"
import { DateTime, Duration, Effect, Exit, Fiber, Option, Stream } from "effect"
import { Event, Ids, Session, Subscription, Wake } from "@exangelos/domain"
import {
  EventRepository,
  OfficialConnectorSource,
  ConnectorAccess,
  ConnectorDirectory,
  ConnectorImportSource,
  ConnectorRuntime,
  SubscriptionRepository,
  WakeRepository,
  WakeTarget
} from "@exangelos/application"
import {
  layerConnectorAccess,
  layerConnectorFiles,
  layerConnectorRuntime,
  layerRepositories,
  layerWakeTarget,
  ConnectorAccessFake,
  ConnectorFilesFake,
  ConnectorRuntimeFake,
  WakeTargetFake
} from "@exangelos/application/testing"
import { catalogue } from "./fixtures.ts"

const at = DateTime.makeUnsafe("2026-11-12T10:00:00Z")
const id = Ids.SubscriptionId.make("sub_abc")
const name = Ids.ConnectorName.make("template")
const session: Session.Session = { harness: "t3", sessionId: "thread-1" }

const subscription: Subscription.Subscription = {
  id,
  connector: name,
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

const content: Wake.WakeContent = { subscription: id, connector: "template", subject: "x", why: { _tag: "Events" }, pending: [] }

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

describe("ConnectorRuntimeFake", () => {
  it.effect("streams scripted items to the picked watch and fails the rest when the connector crashes", () =>
    Effect.scoped(Effect.gen(function*() {
      const runtime = yield* ConnectorRuntime.ConnectorRuntime
      const fake = yield* ConnectorRuntimeFake
      const watching = (subject: string) => (request: { readonly parameters: { readonly [k: string]: unknown } }) =>
        request.parameters["name"] === subject
      yield* fake.define(name, { catalogue })
      yield* fake.emit(name, { _tag: "Cursor", cursor: "c1" }, watching("x"))

      const process = yield* runtime.start({ name, directory: "/connectors/template", entry: { _tag: "Bundle", path: "main.js" }, dev: false })
      const x = yield* Stream.runCollect(process.watch({ parameters: { name: "x" }, eventTypes: [], wakeWindow: Duration.seconds(5) })).pipe(Effect.forkChild)
      const y = yield* Stream.runCollect(process.watch({ parameters: { name: "y" }, eventTypes: [], wakeWindow: Duration.seconds(5) })).pipe(Effect.forkChild)
      yield* Effect.yieldNow
      yield* fake.emit(name, { _tag: "End", reason: "merged" }, watching("x"))

      expect(yield* Fiber.join(x)).toEqual([{ _tag: "Cursor", cursor: "c1" }, { _tag: "End", reason: "merged" }])
      expect(yield* fake.openStreams(name)).toBe(1)

      yield* fake.crash(name, "killed")

      expect(Exit.isFailure(yield* Fiber.await(y))).toBe(true)
      expect((yield* process.exited).reason).toBe("killed")
    })).pipe(Effect.provide(layerConnectorRuntime)))
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

describe("ConnectorFilesFake", () => {
  it.effect("lists an imported connector and reports a change to its files", () =>
    Effect.gen(function*() {
      const directory = yield* ConnectorDirectory.ConnectorDirectory
      const importer = yield* ConnectorImportSource.ConnectorImportSource
      const fake = yield* ConnectorFilesFake
      const source = { _tag: "Directory", path: "/src/template" } as const
      yield* fake.offer(source, { name, version: "1.0.0", directory: "/src/template", entry: { _tag: "Bundle", path: "main.js" }, digest: "d1" })

      const placed = yield* importer.place(source)
      const changed = yield* directory.changes(placed).pipe(Stream.take(1), Stream.runDrain, Effect.forkChild)
      yield* Effect.yieldNow
      yield* fake.edit(placed, "d2")
      yield* Fiber.join(changed)

      expect((yield* directory.list).map((p) => p.name)).toEqual(["template"])
      expect((yield* directory.read(placed)).digest).toBe("d2")
    }).pipe(Effect.provide(layerConnectorFiles([]))))
})

describe("ConnectorAccessFake", () => {
  it.effect("joins the positional main parameter after the connector is ready", () =>
    Effect.gen(function*() {
      const access = yield* ConnectorAccess.ConnectorAccess
      const fake = yield* ConnectorAccessFake
      const official = Ids.ConnectorName.make("official")
      yield* fake.define(name, {
        catalogue,
        describe: (parameters) => Effect.succeed({ catalogue, parameters, subject: String(parameters["name"]), label: "x" })
      })
      yield* fake.define(official, {
        catalogue,
        ready: Effect.fail(new OfficialConnectorSource.OfficialFetchFailed({ connector: official, reason: "offline" })),
        describe: () => Effect.die("not ready")
      })
      const you = { _tag: "You" } as const
      const conflicting = { parameters: { name: "y" }, main: Option.some("x") }

      const described = yield* access.describe(you, name, { parameters: {}, main: Option.some("x") })
      const refused = yield* Effect.flip(access.describe(you, name, conflicting))
      const unready = yield* Effect.flip(access.describe(you, official, conflicting))

      expect(described.subject).toBe("x")
      expect(refused._tag).toBe("ParametersInvalid")
      expect(unready._tag).toBe("OfficialFetchFailed")
    }).pipe(Effect.provide(layerConnectorAccess)))
})
