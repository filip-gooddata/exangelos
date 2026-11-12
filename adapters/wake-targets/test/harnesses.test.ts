import { describe, expect, it } from "@effect/vitest"
import { Duration, Effect, Exit, Layer } from "effect"
import { WakeTarget } from "@exangelos/application"
import { WakeText } from "@exangelos/contracts"
import type { Session } from "@exangelos/domain"
import { ClaudeCode, Codex, layer, T3 } from "../src/index.ts"
import { content, exited, recordingSpawner } from "./fixtures.ts"

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
        Effect.provide(layer().pipe(Layer.provide(runner.layer)))
      )
    )
    return { exit, spawned: yield* runner.spawned }
  })

describe("T3 Code", () => {
  it("maps what t3 returns", () => {
    expect(T3.interpret(exited(0))).toEqual({ _tag: "Delivered" })
    expect(T3.interpret(exited(0, "", "warning: slow"))).toEqual({ _tag: "Delivered" })
    expect(T3.interpret(exited(1, "", "thread not found\n"))).toEqual({
      _tag: "Failed",
      reason: "t3 exited with 1: thread not found"
    })
    expect(T3.interpret(timedOut)).toEqual({ _tag: "Failed", reason: "t3 did not finish within 30s" })
  })

  it.effect("sends the text on stdin", () =>
    Effect.gen(function*() {
      const { exit, spawned } = yield* deliverTo({ harness: "t3", sessionId: "thread:delegated-task:abc" })
      expect(Exit.isSuccess(exit)).toBe(true)
      expect(spawned).toEqual([{ program: "t3", args: ["thread", "send", "thread:delegated-task:abc", "-"], stdin: text }])
    }))

  it.effect("refuses a thread id t3 would read as a flag, without running t3", () =>
    Effect.gen(function*() {
      const { exit, spawned } = yield* deliverTo({ harness: "t3", sessionId: "--help:x" })
      expect(Exit.isFailure(exit)).toBe(true)
      expect(spawned).toEqual([])
    }))
})

describe("Codex", () => {
  it("maps what codex queue returns", () => {
    expect(Codex.interpret(exited(0))).toEqual({ _tag: "Delivered" })
    expect(Codex.interpret(exited(0, "", "WARNING: failed to resume thread\n"))).toEqual({
      _tag: "Delivered",
      note: "queued, but codex could not resume the thread: WARNING: failed to resume thread"
    })
    expect(Codex.interpret(exited(2, "", "error: no session\n"))._tag).toBe("Failed")
    expect(Codex.interpret(timedOut)._tag).toBe("Failed")
  })

  it.effect("passes an id that starts with a dash as the value of --thread", () =>
    Effect.gen(function*() {
      const { exit, spawned } = yield* deliverTo({ harness: "codex", sessionId: "-x:1" })
      expect(Exit.isSuccess(exit)).toBe(true)
      expect(spawned).toEqual([{
        program: "codex",
        args: ["queue", "--thread=-x:1", `--message=${text}`, "--resume"],
        stdin: ""
      }])
    }))
})

describe("Claude Code", () => {
  it("maps what claude --bg returns", () => {
    expect(ClaudeCode.interpret(exited(0, "abc123\n"))).toEqual({ _tag: "Delivered" })
    expect(ClaudeCode.interpret(exited(0, "Session is running; started a copy as def456\n"))._tag).toBe("Delivered")
    expect(ClaudeCode.interpret(exited(1, "", "No conversation found\n"))).toEqual({
      _tag: "Failed",
      reason: "claude exited with 1: No conversation found"
    })
    expect(ClaudeCode.interpret(timedOut)._tag).toBe("Failed")
  })

  it.effect("passes an id that starts with a dash as the value of --resume", () =>
    Effect.gen(function*() {
      const { exit, spawned } = yield* deliverTo({ harness: "claude-code", sessionId: "-x:1" })
      expect(Exit.isSuccess(exit)).toBe(true)
      expect(spawned).toEqual([{ program: "claude", args: ["--bg", "--resume=-x:1", "--", text], stdin: "" }])
    }))

  it.effect("reports a non-zero exit as a failed delivery", () =>
    Effect.gen(function*() {
      const { exit } = yield* deliverTo({ harness: "claude-code", sessionId: "abc" }, 1)
      expect(exit).toEqual(Exit.fail(new WakeTarget.DeliveryFailed({ reason: "claude exited with 1" })))
    }))
})
