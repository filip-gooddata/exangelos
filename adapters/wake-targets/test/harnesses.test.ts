import { describe, expect, it } from "@effect/vitest"
import { Duration, Effect, Exit, Fiber, Layer } from "effect"
import { TestClock } from "effect/testing"
import { WakeTarget } from "@exangelos/application"
import { layerSettingsStore } from "@exangelos/application/testing"
import { WakeText } from "@exangelos/contracts"
import type { Session } from "@exangelos/domain"
import { Codex, layer, T3 } from "../src/index.ts"
import { content, exited, fakeBin, recordingSpawner } from "./fixtures.ts"

const timedOut = { _tag: "TimedOut", limit: Duration.seconds(30) } as const
const text = WakeText.render(content)

const deliverTo = (session: Session.Session, exitCode = 0) =>
  Effect.gen(function*() {
    const runner = yield* recordingSpawner({ exitCode })
    const exit = yield* Effect.exit(
      Effect.gen(function*() {
        const target = yield* WakeTarget.WakeTarget
        yield* target.deliver(session, content)
      }).pipe(
        Effect.provide(layer({ lookup: () => fakeBin }).pipe(Layer.provide([runner.layer, layerSettingsStore()])))
      )
    )
    return { exit, spawned: yield* runner.spawned }
  })

describe("T3 Code", () => {
  it("maps what t3 returns", () => {
    expect(T3.interpret(exited(0))).toEqual({ _tag: "Delivered" })
    expect(T3.interpret(exited(0, "WARN Database migration history diverges\nQueued.\n"))).toEqual({ _tag: "Delivered" })
    expect(T3.interpret(exited(1, "WARN Database migration history diverges\n", "Thread t1 is archived and cannot receive messages.\n"))).toEqual({
      _tag: "Failed",
      reason: "t3 exited with 1: Thread t1 is archived and cannot receive messages."
    })
    expect(T3.interpret(timedOut)).toEqual({
      _tag: "Delivered",
      note: "t3 did not finish within 30s; the wake may not have arrived and is not resent"
    })
  })

  it.effect("passes an id that starts with a dash after --, with the text on stdin", () =>
    Effect.gen(function*() {
      const { exit, spawned } = yield* deliverTo({ harness: "t3", sessionId: "-x:1" })
      expect(Exit.isSuccess(exit)).toBe(true)
      expect(spawned).toEqual([{ program: "/fake/bin/t3", args: ["thread", "send", "--", "-x:1", "-"], stdin: text }])
    }))

  it.effect("gives a slow t3 two minutes, then counts the wake as sent rather than resend it", () =>
    Effect.gen(function*() {
      const runner = yield* recordingSpawner({ exitCode: 0, hangs: true })
      const fiber = yield* Effect.gen(function*() {
        yield* (yield* WakeTarget.WakeTarget).deliver({ harness: "t3", sessionId: "t1" }, content)
      }).pipe(
        Effect.provide(layer({ lookup: () => fakeBin }).pipe(Layer.provide([runner.layer, layerSettingsStore()]))),
        Effect.exit,
        Effect.forkChild
      )
      yield* TestClock.adjust("1 minute")
      expect(fiber.pollUnsafe()).toBeUndefined()
      yield* TestClock.adjust("1 minute")
      const exit = yield* Fiber.join(fiber)
      expect(Exit.isSuccess(exit)).toBe(true)
      expect(yield* runner.spawned).toHaveLength(1)
    }))
})

describe("Codex", () => {
  it("maps what codex queue returns", () => {
    expect(Codex.interpret(exited(0))).toEqual({ _tag: "Delivered" })
    const warning = "Warning: message was queued, but could not resume thread t1: start a local daemon or specify a server with --remote"
    expect(Codex.interpret(exited(0, "Queued message m1 for thread t1.\n", `${warning}\n`))).toEqual({
      _tag: "Delivered",
      note: `queued; codex runs it when the thread next resumes: ${warning}`
    })
    expect(Codex.interpret(exited(1, "", "Error: No active session found matching '-nope'.\n"))).toEqual({
      _tag: "Failed",
      reason: "codex exited with 1: Error: No active session found matching '-nope'."
    })
    expect(Codex.interpret(timedOut)._tag).toBe("Failed")
  })

  it.effect("passes an id that starts with a dash as the value of --thread", () =>
    Effect.gen(function*() {
      const { exit, spawned } = yield* deliverTo({ harness: "codex", sessionId: "-x:1" })
      expect(Exit.isSuccess(exit)).toBe(true)
      expect(spawned).toEqual([{
        program: "/fake/bin/codex",
        args: ["queue", "--thread=-x:1", `--message=${text}`, "--resume"],
        stdin: ""
      }])
    }))
})

describe("Claude Code", () => {
  it.effect("fails every wake with a fixed reason and starts no process", () =>
    Effect.gen(function*() {
      const { exit, spawned } = yield* deliverTo({ harness: "claude-code", sessionId: "-x:1" })
      expect(exit).toEqual(Exit.fail(new WakeTarget.DeliveryFailed({
        reason: "Claude Code has no route into a running session; run `exangelos wait sub_7f3k` in the session"
      })))
      expect(spawned).toEqual([])
    }))
})
