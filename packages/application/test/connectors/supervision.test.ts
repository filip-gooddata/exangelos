import { describe, expect, it } from "@effect/vitest"
import { Deferred, Duration, Effect, Layer, Option, Ref } from "effect"
import { TestClock } from "effect/testing"
import { devLink, enableConnector, importConnector, listConnectors, ConnectorAccess, setSettings } from "@exangelos/application"
import { AlertSinkFake, ConnectorFilesFake, ConnectorRuntimeFake, SubscriptionIntakeFake } from "@exangelos/application/testing"
import { type Connector, Settings } from "@exangelos/domain"
import { SettingsStore } from "../../src/ports/SettingsStore.ts"
import { SourceFailed } from "../../src/ports/ConnectorRuntime.ts"
import { activeSubscription, catalogue, installed, name, connectorOf, settle, tick, unavailableReports, withConnectors, withConnectorsOver, you } from "./harness.ts"

/** Alerts other than the one an import raises while it waits to be enabled. */
const failingAlerts = Effect.gen(function*() {
  const shown = yield* (yield* AlertSinkFake).shown
  return shown.filter((alert) => alert._tag !== "WaitsForEnable")
})

const acme = name("acme")

const wakeWindow = (seconds: number) =>
  setSettings(you, { ...Settings.initial, limits: { ...Settings.initial.limits, wakeWindow: Duration.seconds(seconds) } })

const openedWakeWindows = Effect.gen(function*() {
  const watches = yield* (yield* ConnectorRuntimeFake).watches(acme)
  return watches.map((request) => Duration.toSeconds(request.wakeWindow))
})

const runningWith = (icon?: Connector.Icon) => Effect.gen(function*() {
  yield* (yield* ConnectorRuntimeFake).define(acme, { catalogue: catalogue(), ...(icon && { icon }) })
  const source = { _tag: "Directory", path: "/src/acme" } as const
  yield* (yield* ConnectorFilesFake).offer(source, installed("acme"))
  const imported = yield* importConnector(you, source)
  yield* enableConnector(you, acme, imported.digest)
  yield* settle
})

const running = runningWith()

const listedIcon = Effect.map(listConnectors, (all) => all.find((connector) => connector.name === acme)?.icon)


describe("connector supervision", () => {
  it.effect("hands Watch items to the intake and stops a stream the intake stops", () =>
    withConnectors(Effect.gen(function*() {
      yield* running
      const runtime = yield* ConnectorRuntimeFake
      const intake = yield* SubscriptionIntakeFake
      const access = yield* ConnectorAccess.ConnectorAccess
      const one = yield* activeSubscription("acme", "sub_one", "c1")
      const two = yield* activeSubscription("acme", "sub_two")
      yield* access.watch(one)
      yield* access.watch(one)
      yield* access.watch(two)
      yield* settle

      expect(yield* runtime.openStreams(acme)).toBe(2)
      expect((yield* runtime.watches(acme))[0]).toMatchObject({ cursor: "c1", eventTypes: [tick] })
      yield* runtime.emit(acme, { _tag: "Cursor", cursor: "c2" }, (request) => request.parameters.name === "sub_one")
      yield* runtime.emit(acme, { _tag: "End", reason: "merged" }, (request) => request.parameters.name === "sub_two")
      yield* settle

      expect(yield* intake.ingested(one)).toEqual([{ _tag: "Cursor", cursor: "c2" }])
      expect(yield* intake.ingested(two)).toEqual([{ _tag: "End", reason: "merged" }])
      expect(yield* runtime.openStreams(acme)).toBe(1)
      yield* access.unwatch(one)
      yield* settle
      expect(yield* runtime.openStreams(acme)).toBe(0)
    })))

  it.effect("opens a Watch with the wake window setting and reopens it when the setting changes", () =>
    withConnectors(Effect.gen(function*() {
      yield* running
      const runtime = yield* ConnectorRuntimeFake
      yield* wakeWindow(2)
      yield* (yield* ConnectorAccess.ConnectorAccess).watch(yield* activeSubscription("acme", "sub_one"))
      yield* settle
      yield* wakeWindow(7)
      yield* settle
      yield* wakeWindow(7)
      yield* settle

      expect(yield* openedWakeWindows).toEqual([2, 7])
      expect(yield* runtime.openStreams(acme)).toBe(1)
    })))

  it.effect("reopens with the new wake window a stream that was reading the old one", () =>
    Effect.gen(function*() {
      const stored = yield* Ref.make(Settings.initial)
      const holdNextRead = yield* Ref.make(false)
      const reading = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const store = Layer.succeed(SettingsStore, {
        read: Effect.gen(function*() {
          const settings = yield* Ref.get(stored)
          if (yield* Ref.getAndSet(holdNextRead, false)) {
            yield* Deferred.succeed(reading, undefined)
            yield* Deferred.await(release)
          }
          return settings
        }),
        write: (settings) => Ref.set(stored, settings),
        update: (change) => Ref.get(stored).pipe(Effect.flatMap(change), Effect.tap((settings) => Ref.set(stored, settings)))
      })
      yield* withConnectorsOver(store)(Effect.gen(function*() {
        yield* running
        const access = yield* ConnectorAccess.ConnectorAccess
        const id = yield* activeSubscription("acme", "sub_one")
        yield* wakeWindow(2)
        yield* access.watch(id)
        yield* settle
        yield* Ref.set(holdNextRead, true)
        yield* Effect.forkChild(access.rewatch(id))
        yield* Deferred.await(reading)
        yield* wakeWindow(7)
        yield* settle
        yield* Deferred.succeed(release, undefined)
        yield* settle

        expect(yield* openedWakeWindows).toEqual([2, 7])
      }))
    }))

  it.effect("reports a failing stream's outage to the intake, bounded, and its recovery on the next item", () =>
    withConnectors(Effect.gen(function*() {
      yield* running
      const runtime = yield* ConnectorRuntimeFake
      const intake = yield* SubscriptionIntakeFake
      const access = yield* ConnectorAccess.ConnectorAccess
      const one = yield* activeSubscription("acme", "sub_one")
      yield* access.watch(one)
      yield* settle

      yield* runtime.fail(acme, new SourceFailed({ connector: acme, category: "unavailable", reason: "x".repeat(500) }))
      yield* settle
      yield* TestClock.adjust("1 second")
      yield* settle
      yield* runtime.fail(acme, new SourceFailed({ connector: acme, category: "unavailable", reason: "x".repeat(500) }))
      yield* settle

      const failures = (yield* intake.observations).flatMap((report) => report.failure === undefined ? [] : [report.failure])
      expect(failures).toHaveLength(2)
      expect(failures[1]?.since).toEqual(failures[0]?.since)
      expect(failures[0]?.reason).toHaveLength(300)
      expect(Option.getOrThrow(yield* access.observation(one))).toMatchObject({ category: "unavailable" })
      const status = (yield* listConnectors).find((connector) => connector.name === acme)
      expect(status?.observation).toEqual({ affectedWatches: 1, categories: ["unavailable"] })

      yield* TestClock.adjust("2 minutes")
      yield* settle
      expect((yield* intake.observations).at(-1)?.failure).toBeDefined()
      expect(yield* access.reading(one)).toBe(false)
      yield* runtime.emit(acme, { _tag: "Cursor", cursor: "c1" })
      yield* settle
      expect((yield* intake.observations).at(-1)).toEqual({ subscription: one })
      expect(yield* access.reading(one)).toBe(true)
      expect(yield* access.observation(one)).toEqual(Option.none())
    })))

  it.effect("restarts a crashed connector and reopens its streams", () =>
    withConnectors(Effect.gen(function*() {
      yield* running
      const runtime = yield* ConnectorRuntimeFake
      yield* (yield* ConnectorAccess.ConnectorAccess).watch(yield* activeSubscription("acme", "sub_one"))
      yield* settle

      yield* runtime.crash(acme, "segfault")
      yield* settle
      expect(yield* connectorOf("acme")).toMatchObject({ process: "restarting" })
      yield* TestClock.adjust("1 second")
      yield* settle

      expect(yield* runtime.launches(acme)).toHaveLength(2)
      expect(yield* runtime.openStreams(acme)).toBe(1)
      expect(yield* connectorOf("acme")).toMatchObject({ process: "running" })
      expect(yield* failingAlerts).toEqual([])
    })))

  it.effect("lists the logo the connector served, keeps it while the connector is down and takes the next process's answer", () =>
    withConnectors(Effect.gen(function*() {
      const icon: Connector.Icon = { mediaType: "image/svg+xml", data: "PHN2Zy8+" }
      yield* runningWith(icon)
      const runtime = yield* ConnectorRuntimeFake
      expect(yield* listedIcon).toEqual(icon)

      yield* runtime.define(acme, { catalogue: catalogue() })
      yield* runtime.crash(acme, "segfault")
      yield* settle
      expect(yield* connectorOf("acme")).toMatchObject({ process: "restarting" })
      expect(yield* listedIcon).toEqual(icon)

      yield* TestClock.adjust("1 second")
      yield* settle
      expect(yield* connectorOf("acme")).toMatchObject({ process: "running" })
      expect(yield* listedIcon).toBeUndefined()
    })))

  it.effect("keeps the last logo when the next process does not answer in time", () =>
    withConnectors(Effect.gen(function*() {
      const icon: Connector.Icon = { mediaType: "image/svg+xml", data: "PHN2Zy8+" }
      yield* runningWith(icon)
      const runtime = yield* ConnectorRuntimeFake
      yield* runtime.define(acme, { catalogue: catalogue(), icon: { _tag: "Hang" } })
      yield* runtime.crash(acme, "segfault")
      yield* settle
      yield* TestClock.adjust("1 second")
      yield* settle
      expect(yield* connectorOf("acme")).toMatchObject({ process: "running" })
      yield* TestClock.adjust("10 seconds")
      yield* settle
      expect(yield* listedIcon).toEqual(icon)
    })))

  it.effect("marks a connector that keeps failing, alerts you and suspends its subscriptions after an hour", () =>
    withConnectors(Effect.gen(function*() {
      yield* running
      const before = yield* unavailableReports("acme")
      const runtime = yield* ConnectorRuntimeFake
      yield* runtime.define(acme, { catalogue: catalogue(), start: { _tag: "Fail", reason: "exec format error" } })
      yield* runtime.crash(acme, "segfault")
      const minutes = (count: number) =>
        Effect.forEach(Array.from({ length: count }), () => Effect.andThen(TestClock.adjust("1 minute"), settle), {
          discard: true
        })

      yield* minutes(1)
      expect(yield* connectorOf("acme")).toMatchObject({ process: "failing" })
      expect(yield* failingAlerts).toEqual([expect.objectContaining({ connector: "acme" })])
      expect(yield* unavailableReports("acme")).toBe(before + 1)

      yield* minutes(60)
      expect(yield* unavailableReports("acme")).toBe(before + 2)
      expect(yield* failingAlerts).toHaveLength(1)
    })))

  it.effect("restarts a dev-linked connector when its files change", () =>
    withConnectors(Effect.gen(function*() {
      const runtime = yield* ConnectorRuntimeFake
      const files = yield* ConnectorFilesFake
      yield* runtime.define(acme, { catalogue: catalogue() })
      yield* files.put(installed("acme", "sha256-a", "/work/acme"))

      const linked = yield* devLink(you, "/work/acme")
      yield* settle
      yield* files.edit("/work/acme", "sha256-b")
      yield* settle

      expect(linked.trust).toBe("dev")
      expect(yield* runtime.launches(acme)).toEqual([
        expect.objectContaining({ dev: true, directory: "/work/acme" }),
        expect.objectContaining({ dev: true, directory: "/work/acme" })
      ])
      expect(yield* connectorOf("acme")).toMatchObject({ trust: "dev", digest: "sha256-b", process: "running" })
    })))
})
