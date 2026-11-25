import { describe, expect, it } from "@effect/vitest"
import { Duration, Effect, Fiber, Option, Ref } from "effect"
import { TestClock } from "effect/testing"
import type { Session } from "@exangelos/domain"
import { SessionTitles, T3 } from "../src/index.ts"
import { type Answer, exited, fakeBin, recordingSpawner } from "./fixtures.ts"

const shown = (title: string) => JSON.stringify({ thread: { threadId: "thread-1", title, archived: false }, messages: [] })
const thread: Session.Target = { harness: "t3", sessionId: "thread-1" }

const withTitles = (answer: { readonly exitCode: number; readonly stdout?: string }) =>
  Effect.gen(function*() {
    const runner = yield* recordingSpawner(answer)
    const service = yield* SessionTitles.make({ lookup: () => fakeBin }).pipe(Effect.provide(runner.layer))
    return { titles: service.titles, lookup: service.lookup, spawned: runner.spawned }
  })

describe("T3 thread titles", () => {
  it("reads the trimmed title of a shown thread", () => {
    expect(T3.title(exited(0, shown("  Tray design pass \n")))).toEqual(Option.some("Tray design pass"))
    expect(T3.title(exited(0, `WARN Database migration history diverges\n${JSON.stringify(JSON.parse(shown("Tray")), null, 2)}\n`)))
      .toEqual(Option.some("Tray"))
  })

  it("has no title for a failed run, garbage or a blank title", () => {
    expect(T3.title(exited(1, "", "Thread thread-1 is no longer available.\n"))).toEqual(Option.none())
    expect(T3.title({ _tag: "TimedOut", limit: Duration.seconds(5) })).toEqual(Option.none())
    expect(T3.title({ _tag: "NotStarted", reason: "no t3" })).toEqual(Option.none())
    expect(T3.title(exited(0, "not json"))).toEqual(Option.none())
    expect(T3.title(exited(0, JSON.stringify({ thread: {} })))).toEqual(Option.none())
    expect(T3.title(exited(0, shown("   ")))).toEqual(Option.none())
  })
})

describe("session titles", () => {
  it.effect("names a T3 thread through t3 thread show and leaves out harnesses without a resolver", () =>
    Effect.scoped(Effect.gen(function*() {
      const { lookup, spawned } = yield* withTitles({ exitCode: 0, stdout: shown("Tray design pass") })
      const result = yield* lookup([
        thread,
        { harness: "codex", sessionId: "c-1" },
        { harness: "claude-code", sessionId: "cc-1" },
        { harness: "my-agent", sessionId: "m-1" },
        { harness: "constructor", sessionId: "k-1" }
      ])
      expect(result).toEqual([{ harness: "t3", sessionId: "thread-1", title: "Tray design pass" }])
      expect(yield* spawned).toEqual([{
        program: "/fake/bin/t3",
        args: ["--log-level", "fatal", "thread", "show", "--json", "--messages", "0", "--", "thread-1"],
        stdin: ""
      }])
    })))

  it.effect("leaves out a session t3 doesn't know or that has no t3 to ask", () =>
    Effect.scoped(Effect.gen(function*() {
      const { lookup } = yield* withTitles({ exitCode: 1 })
      expect(yield* lookup([thread])).toEqual([])
      const runner = yield* recordingSpawner({ exitCode: 0, stdout: shown("Tray") })
      const nowhere = { ...fakeBin, isExecutable: () => false }
      const missing = yield* SessionTitles.make({ lookup: () => nowhere }).pipe(Effect.provide(runner.layer))
      expect(yield* missing.lookup([thread])).toEqual([])
      expect(yield* runner.spawned).toEqual([])
    })))

  it.effect("keeps a found title for 10 minutes", () =>
    Effect.scoped(Effect.gen(function*() {
      const { lookup, spawned } = yield* withTitles({ exitCode: 0, stdout: shown("Tray") })
      yield* lookup([thread, thread])
      yield* TestClock.adjust("9 minutes")
      yield* lookup([thread])
      expect(yield* spawned).toHaveLength(1)
      yield* TestClock.adjust("2 minutes")
      expect(yield* lookup([thread])).toEqual([{ ...thread, title: "Tray" }])
      expect(yield* spawned).toHaveLength(2)
    })))

  it.effect("keeps a missing title for 2 minutes", () =>
    Effect.scoped(Effect.gen(function*() {
      const { lookup, spawned } = yield* withTitles({ exitCode: 1 })
      yield* lookup([thread])
      yield* TestClock.adjust("1 minute")
      yield* lookup([thread])
      expect(yield* spawned).toHaveLength(1)
      yield* TestClock.adjust("90 seconds")
      yield* lookup([thread])
      expect(yield* spawned).toHaveLength(2)
    })))

  it.effect("answers a poll from what it knows and looks up the rest in the background", () =>
    Effect.scoped(Effect.gen(function*() {
      const { lookup, spawned, titles } = yield* withTitles({ exitCode: 0, stdout: shown("Tray") })
      expect(yield* titles([thread])).toEqual([])
      yield* lookup([thread])
      expect(yield* titles([thread])).toEqual([{ ...thread, title: "Tray" }])
      expect(yield* spawned).toHaveLength(1)
    })))

  it.effect("keeps the last found title when a refresh times out, and across a restart", () =>
    Effect.scoped(Effect.gen(function*() {
      let answer: Answer = { exitCode: 0, stdout: shown("Tray") }
      const runner = yield* recordingSpawner(() => answer)
      const saved = yield* Ref.make<ReadonlyArray<Session.SessionTitle>>([])
      const memory: SessionTitles.Memory = { load: Ref.get(saved), save: (all) => Ref.set(saved, all).pipe(Effect.as(true)) }
      const start = SessionTitles.make({ lookup: () => fakeBin, memory }).pipe(Effect.provide(runner.layer))
      const service = yield* start
      yield* service.lookup([thread])
      answer = { exitCode: 0, hangs: true }
      yield* TestClock.adjust("11 minutes")
      const refresh = yield* Effect.forkChild(service.lookup([thread]))
      yield* TestClock.adjust("15 seconds")
      expect(yield* Fiber.join(refresh)).toEqual([{ ...thread, title: "Tray" }])
      expect(yield* service.titles([thread])).toEqual([{ ...thread, title: "Tray" }])
      expect(yield* runner.spawned).toHaveLength(2)
      const restarted = yield* start
      expect(yield* restarted.titles([thread])).toEqual([{ ...thread, title: "Tray" }])
    })))

  it.effect("saves a title again after a failed save, even when it hasn't changed", () =>
    Effect.scoped(Effect.gen(function*() {
      const runner = yield* recordingSpawner({ exitCode: 0, stdout: shown("Tray") })
      const saved = yield* Ref.make<ReadonlyArray<Session.SessionTitle>>([])
      const writable = yield* Ref.make(false)
      const memory: SessionTitles.Memory = {
        load: Ref.get(saved),
        save: (all) => Effect.flatMap(Ref.get(writable), (ok) => ok ? Ref.set(saved, all).pipe(Effect.as(true)) : Effect.succeed(false))
      }
      const service = yield* SessionTitles.make({ lookup: () => fakeBin, memory }).pipe(Effect.provide(runner.layer))
      yield* service.lookup([thread])
      expect(yield* Ref.get(saved)).toEqual([])
      yield* Ref.set(writable, true)
      yield* TestClock.adjust("11 minutes")
      yield* service.lookup([thread])
      expect(yield* Ref.get(saved)).toEqual([{ ...thread, title: "Tray" }])
    })))
})
