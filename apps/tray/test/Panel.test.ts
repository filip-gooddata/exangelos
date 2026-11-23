import { describe, expect, it } from "@effect/vitest"
import { DaemonContract } from "@exangelos/contracts"
import { Ids, ConnectorRules, Settings } from "@exangelos/domain"
import { Effect, Option, Ref, Result } from "effect"
import { TestClock } from "effect/testing"
import { DaemonClient, Host, Panel } from "../src/index.ts"
import { connector, subscription } from "./fixtures.ts"

type Answer = Effect.Effect<DaemonClient.Snapshot, DaemonClient.DaemonNotRunning>

const rest = {
  details: Result.succeed([]),
  titles: Result.succeed([]),
  settings: Result.succeed(Settings.initial),
  status: Result.succeed({ version: "1.0.0", startMethod: "foreground" as const })
}

const loaded = (
  subscriptions: ReadonlyArray<ReturnType<typeof subscription>>,
  connectors: ReadonlyArray<ReturnType<typeof connector>>
): Answer =>
  Effect.succeed({
    subscriptions: Result.succeed(subscriptions),
    connectors: Result.succeed(connectors),
    trustAlerts: Result.succeed(connectors.flatMap((p) => Option.toArray(ConnectorRules.trustAlert(p, Option.none())))),
    ...rest
  })

const healthy = loaded([subscription()], [connector()])
const failing = loaded([], [connector({ process: "failing" })])
const absent: Answer = Effect.fail(new DaemonClient.DaemonNotRunning({ message: "SocketOpenError: no such file" }))

const start = (
  first: Answer,
  refusals = 0,
  act: (request: Panel.Request) => Effect.Effect<void, Panel.Refusal> = () => Effect.void
) =>
  Effect.gen(function*() {
    const answer = yield* Ref.make(first)
    const sent: Array<boolean> = []
    const panel = yield* Panel.make({
      interval: "5 seconds",
      act,
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
    return { answer, panel, sent, next }
  })

describe("panel state", () => {
  it.effect("shows loading until the first load answers", () =>
    Effect.gen(function*() {
      const { panel } = yield* start(Effect.never)
      expect((yield* panel.current)._tag).toBe("Loading")
    }).pipe(Effect.scoped))

  it.effect("loads subscriptions and connectors and lists what needs you", () =>
    Effect.gen(function*() {
      const { panel, sent } = yield* start(loaded(
        [subscription()],
        [
          connector({ name: Ids.ConnectorName.make("ok") }),
          connector({ name: Ids.ConnectorName.make("new"), trust: "inert" }),
          connector({ name: Ids.ConnectorName.make("official"), trust: "inert", origin: { _tag: "Official", version: "1" } }),
          connector({ name: Ids.ConnectorName.make("crashy"), process: "failing" }),
          connector({ name: Ids.ConnectorName.make("locked"), configuration: { _tag: "Rejected", reason: "401" } })
        ]
      ))
      const state = yield* panel.current
      if (state._tag !== "Ready") return expect.fail(state._tag)
      expect(Result.getOrThrow(state.subscriptions).map((s) => s.id)).toEqual(["sub_7f3k"])
      expect(Result.getOrThrow(state.connectors)).toHaveLength(5)
      expect(Result.getOrThrow(state.needsYou).map((alert) => [alert._tag, "connector" in alert ? alert.connector : ""])).toEqual([
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
  it.effect("keeps the connectors and the icon when only the subscriptions fail", () =>
    Effect.gen(function*() {
      const { panel, sent } = yield* start(Effect.succeed({
        subscriptions: Result.fail("NotImplemented: List"),
        connectors: Result.succeed([connector({ process: "failing" })]),
        trustAlerts: Result.succeed([]),
        ...rest
      }))
      const state = yield* panel.current
      if (state._tag !== "Ready") return expect.fail(state._tag)
      expect(state.subscriptions).toStrictEqual(Result.fail("NotImplemented: List"))
      expect(Result.getOrThrow(state.connectors)).toHaveLength(1)
      expect(sent).toEqual([true])
    }).pipe(Effect.scoped))
  it.effect("loads again after a request succeeds and not after a refusal", () =>
    Effect.gen(function*() {
      const refused = new DaemonContract.TransitionRefused({ state: { _tag: "Expired" }, message: "expired" })
      const { answer, panel } = yield* start(healthy, 0, (request) => request._tag === "Pause" ? Effect.fail(refused) : Effect.void)
      const count = (state: Panel.PanelState) => state._tag === "Ready" ? Result.getOrThrow(state.subscriptions).length : -1
      yield* Ref.set(answer, loaded([subscription(), subscription()], [connector()]))
      const id = Ids.SubscriptionId.make("sub_7f3k")
      expect(yield* Effect.flip(panel.perform(Panel.Request.Pause({ id })))).toBe(refused)
      expect(count(yield* panel.current)).toBe(1)
      yield* panel.perform(Panel.Request.Resume({ id }))
      expect(count(yield* panel.current)).toBe(2)
    }).pipe(Effect.scoped))
})

describe("subscriptions by session", () => {
  it("groups by wake target with pull-only last and states each fact", () => {
    const other = { harness: "codex", sessionId: "docs" } as const
    const groups = Panel.bySession([
      subscription({ id: Ids.SubscriptionId.make("sub_a"), lastNumber: 3, ackedThrough: 1 }),
      subscription({ id: Ids.SubscriptionId.make("sub_b"), wakeTarget: other, state: { _tag: "Expired" } }),
      subscription({
        id: Ids.SubscriptionId.make("sub_c"),
        state: { _tag: "Paused", reason: { _tag: "BacklogCount", limit: 20 } }
      }),
      { ...subscription({ id: Ids.SubscriptionId.make("sub_d") }), wakeTarget: undefined }
    ].map(({ wakeTarget, ...rest }) => wakeTarget === undefined ? rest : { ...rest, wakeTarget }))
    expect(groups.map((g) => [Option.getOrUndefined(g.wakeTarget)?.sessionId, g.subscriptions.map(Panel.stateFact)])).toEqual([
      ["thread-alice", ["2 pending", "Paused: backlog reached 20 pending events"]],
      ["docs", ["Expired"]],
      [undefined, ["Active"]]
    ])
  })
})
