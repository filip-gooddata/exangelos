import { describe, expect, it } from "@effect/vitest"
import { Ids, PluginRules } from "@exangelos/domain"
import { Effect, Option, Ref, Result } from "effect"
import { TestClock } from "effect/testing"
import { DaemonClient, Host, Panel } from "../src/index.ts"
import { plugin, subscription } from "./fixtures.ts"

type Answer = Effect.Effect<DaemonClient.Snapshot, DaemonClient.DaemonNotRunning | DaemonClient.DaemonUnreachable>

const loaded = (
  subscriptions: ReadonlyArray<ReturnType<typeof subscription>>,
  plugins: ReadonlyArray<ReturnType<typeof plugin>>
): Answer =>
  Effect.succeed({
    subscriptions: Result.succeed(subscriptions),
    plugins: Result.succeed(plugins),
    trustAlerts: Result.succeed(plugins.flatMap((p) => Option.toArray(PluginRules.trustAlert(p, Option.none()))))
  })

const healthy = loaded([subscription()], [plugin()])
const failing = loaded([], [plugin({ process: "failing" })])
const absent: Answer = Effect.fail(new DaemonClient.DaemonNotRunning({ message: "SocketOpenError: no such file" }))

const start = (first: Answer, refusals = 0) =>
  Effect.gen(function*() {
    const answer = yield* Ref.make(first)
    const sent: Array<boolean> = []
    const panel = yield* Panel.make({
      interval: "5 seconds",
      load: Effect.flatten(Ref.get(answer)),
      setAttention: (needsYou) =>
        Effect.suspend(() => {
          sent.push(needsYou)
          return sent.length <= refusals
            ? Effect.fail(new Host.HostCommandFailed({ command: "tray_set_attention", message: "refused" }))
            : Effect.void
        })
    })
    yield* TestClock.adjust("1 millis")
    const next = (answer_: Answer) =>
      Ref.set(answer, answer_).pipe(Effect.andThen(TestClock.adjust("5 seconds")))
    return { panel, sent, next }
  })

describe("panel state", () => {
  it.effect("loads subscriptions and plugins and lists what needs you", () =>
    Effect.gen(function*() {
      const { panel, sent } = yield* start(loaded(
        [subscription()],
        [
          plugin({ name: Ids.PluginName.make("ok") }),
          plugin({ name: Ids.PluginName.make("new"), trust: "inert" }),
          plugin({ name: Ids.PluginName.make("official"), trust: "inert", origin: { _tag: "Official", version: "1" } }),
          plugin({ name: Ids.PluginName.make("crashy"), process: "failing" }),
          plugin({ name: Ids.PluginName.make("locked"), configuration: { _tag: "Rejected", reason: "401" } })
        ]
      ))
      const state = yield* panel.current
      if (state._tag !== "Ready") return expect.fail(state._tag)
      expect(Result.getOrThrow(state.subscriptions).map((s) => s.id)).toEqual(["sub_7f3k"])
      expect(Result.getOrThrow(state.plugins)).toHaveLength(5)
      expect(Result.getOrThrow(state.needsYou).map((alert) => [alert._tag, "plugin" in alert ? alert.plugin : ""])).toEqual([
        ["WaitsForEnable", "new"],
        ["DigestMismatch", "official"],
        ["Failing", "crashy"],
        ["CredentialsRejected", "locked"]
      ])
      expect(sent).toEqual([true])
    }).pipe(Effect.scoped))

  it.effect("tells the host only when the needs-you list turns empty or non-empty", () =>
    Effect.gen(function*() {
      const { next, sent } = yield* start(failing)
      yield* next(failing)
      yield* next(healthy)
      yield* next(healthy)
      yield* next(failing)
      expect(sent).toEqual([true, false, true])
    }).pipe(Effect.scoped))

  it.effect("shows the daemon as not running, then loads once it appears", () =>
    Effect.gen(function*() {
      const { next, panel, sent } = yield* start(absent)
      expect((yield* panel.current)._tag).toBe("DaemonNotRunning")
      yield* next(healthy)
      const state = yield* panel.current
      expect(state._tag === "Ready" && Result.getOrThrow(state.subscriptions).length).toBe(1)
      expect(sent).toEqual([false])
    }).pipe(Effect.scoped))
  it.effect("keeps the icon while the daemon is gone and tells a refusing host again", () =>
    Effect.gen(function*() {
      const { next, panel, sent } = yield* start(failing, 1)
      yield* next(absent)
      expect((yield* panel.current)._tag).toBe("DaemonNotRunning")
      yield* next(failing)
      yield* next(failing)
      expect(sent).toEqual([true, true])
    }).pipe(Effect.scoped))
  it.effect("keeps the plugins and the icon when only the subscriptions fail", () =>
    Effect.gen(function*() {
      const { panel, sent } = yield* start(Effect.succeed({
        subscriptions: Result.fail("NotImplemented: List"),
        plugins: Result.succeed([plugin({ process: "failing" })]),
        trustAlerts: Result.succeed([])
      }))
      const state = yield* panel.current
      if (state._tag !== "Ready") return expect.fail(state._tag)
      expect(state.subscriptions).toStrictEqual(Result.fail("NotImplemented: List"))
      expect(Result.getOrThrow(state.plugins)).toHaveLength(1)
      expect(sent).toEqual([true])
    }).pipe(Effect.scoped))
})
