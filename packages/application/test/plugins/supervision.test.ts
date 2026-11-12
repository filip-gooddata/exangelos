import { describe, expect, it } from "@effect/vitest"
import { Duration, Effect } from "effect"
import { TestClock } from "effect/testing"
import { devLink, enablePlugin, importPlugin, PluginAccess, setSettings } from "@exangelos/application"
import { AlertSinkFake, PluginFilesFake, PluginRuntimeFake, SubscriptionIntakeFake } from "@exangelos/application/testing"
import { Settings } from "@exangelos/domain"
import { activeSubscription, catalogue, installed, name, pluginOf, settle, tick, unavailableReports, withPlugins, you } from "./harness.ts"

/** Alerts other than the one an import raises while it waits to be enabled. */
const failingAlerts = Effect.gen(function*() {
  const shown = yield* (yield* AlertSinkFake).shown
  return shown.filter((alert) => alert._tag !== "WaitsForEnable")
})

const acme = name("acme")

const running = Effect.gen(function*() {
  yield* (yield* PluginRuntimeFake).define(acme, { catalogue: catalogue() })
  const source = { _tag: "Directory", path: "/src/acme" } as const
  yield* (yield* PluginFilesFake).offer(source, installed("acme"))
  const imported = yield* importPlugin(you, source)
  yield* enablePlugin(you, acme, imported.digest)
  yield* settle
})


describe("plugin supervision", () => {
  it.effect("hands Watch items to the intake and stops a stream the intake stops", () =>
    withPlugins(Effect.gen(function*() {
      yield* running
      const runtime = yield* PluginRuntimeFake
      const intake = yield* SubscriptionIntakeFake
      const access = yield* PluginAccess.PluginAccess
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
    withPlugins(Effect.gen(function*() {
      const wakeWindow = (seconds: number) =>
        setSettings({ ...Settings.initial, limits: { ...Settings.initial.limits, wakeWindow: Duration.seconds(seconds) } })
      yield* running
      const runtime = yield* PluginRuntimeFake
      yield* wakeWindow(2)
      yield* (yield* PluginAccess.PluginAccess).watch(yield* activeSubscription("acme", "sub_one"))
      yield* settle
      yield* wakeWindow(7)
      yield* settle
      yield* wakeWindow(7)
      yield* settle

      expect((yield* runtime.watches(acme)).map((request) => Duration.toSeconds(request.wakeWindow))).toEqual([2, 7])
      expect(yield* runtime.openStreams(acme)).toBe(1)
    })))

  it.effect("restarts a crashed plugin and reopens its streams", () =>
    withPlugins(Effect.gen(function*() {
      yield* running
      const runtime = yield* PluginRuntimeFake
      yield* (yield* PluginAccess.PluginAccess).watch(yield* activeSubscription("acme", "sub_one"))
      yield* settle

      yield* runtime.crash(acme, "segfault")
      yield* settle
      expect(yield* pluginOf("acme")).toMatchObject({ process: "restarting" })
      yield* TestClock.adjust("1 second")
      yield* settle

      expect(yield* runtime.launches(acme)).toHaveLength(2)
      expect(yield* runtime.openStreams(acme)).toBe(1)
      expect(yield* pluginOf("acme")).toMatchObject({ process: "running" })
      expect(yield* failingAlerts).toEqual([])
    })))

  it.effect("marks a plugin that keeps failing, alerts you and suspends its subscriptions after an hour", () =>
    withPlugins(Effect.gen(function*() {
      yield* running
      const before = yield* unavailableReports("acme")
      const runtime = yield* PluginRuntimeFake
      yield* runtime.define(acme, { catalogue: catalogue(), start: { _tag: "Fail", reason: "exec format error" } })
      yield* runtime.crash(acme, "segfault")
      const minutes = (count: number) =>
        Effect.forEach(Array.from({ length: count }), () => Effect.andThen(TestClock.adjust("1 minute"), settle), {
          discard: true
        })

      yield* minutes(1)
      expect(yield* pluginOf("acme")).toMatchObject({ process: "failing" })
      expect(yield* failingAlerts).toEqual([expect.objectContaining({ plugin: "acme" })])
      expect(yield* unavailableReports("acme")).toBe(before + 1)

      yield* minutes(60)
      expect(yield* unavailableReports("acme")).toBe(before + 2)
      expect(yield* failingAlerts).toHaveLength(1)
    })))

  it.effect("restarts a dev-linked plugin when its files change", () =>
    withPlugins(Effect.gen(function*() {
      const runtime = yield* PluginRuntimeFake
      const files = yield* PluginFilesFake
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
      expect(yield* pluginOf("acme")).toMatchObject({ trust: "dev", digest: "sha256-b", process: "running" })
    })))
})
