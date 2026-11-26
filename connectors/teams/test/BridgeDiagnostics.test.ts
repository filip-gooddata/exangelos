import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Sink, Stream } from "effect"
import { ChildProcessSpawner } from "effect/process"
import { TestClock } from "effect/testing"
import { vi } from "vitest"
import { childDetail, recordFailure } from "../src/LastError.ts"
import { localSource } from "../src/Source.ts"

it("accepts only bounded structural coordinates from failed child output", () => {
  const detail = { exception: "OSError", frames: [["bridge", 123]], errno: 2 }
  expect(childDetail(JSON.stringify({ ...detail, message: "sensitive" }))).toEqual(detail)
  for (const input of [{ ...detail, frames: [["sensitive", 123]] }, { ...detail, exception: "sensitive" },
    { ...detail, errno: "sensitive" }, { ...detail, frames: [["bridge", 123, "sensitive"]] }]) {
    expect(childDetail(JSON.stringify(input))).toBeUndefined()
  }
})

it("refuses a symlinked private state directory", () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "teams-linked-state-")))
  vi.stubEnv("EXANGELOS_HOME", home)
  try {
    const target = join(home, "other")
    mkdirSync(target, { mode: 0o700 })
    symlinkSync(target, join(home, "connector-state"))
    recordFailure("resolve", { wall: Date.now(), monotonic: performance.now() }, { stage: "spawn" })
    expect(existsSync(join(target, "teams"))).toBe(false)
  } finally {
    vi.unstubAllEnvs()
    rmSync(home, { recursive: true, force: true })
  }
})

for (const delayed of [false, true]) {
  it.effect(`outer deadline with ${delayed ? "late" : "on-time"} timer handling`, () => Effect.gen(function*() {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "teams-deadline-")))
    vi.stubEnv("EXANGELOS_HOME", home)
    const now = vi.spyOn(Date, "now")
    try {
      const started = yield* Deferred.make<void>()
      let attempts = 0
      const scope = "a".repeat(64)
      const request = { scope, includeMessagePreview: false }
      const spawner = ChildProcessSpawner.make(() => Effect.gen(function*() {
        if (++attempts === 1) {
          yield* Deferred.succeed(started, undefined)
          return yield* Effect.never
        }
        const output = Stream.make(new TextEncoder().encode(JSON.stringify({ ...request, messages: [] })))
        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1), exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
          isRunning: Effect.succeed(false), kill: () => Effect.void, stdin: Sink.drain,
          stdout: output, stderr: Stream.empty, all: output, getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty, unref: Effect.succeed(Effect.void)
        })
      }))
      const fiber = yield* localSource.read(request).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.result, Effect.forkScoped
      )
      yield* Deferred.await(started)
      now.mockReturnValue(Date.now() + (delayed ? 95_000 : 45_000))
      yield* TestClock.adjust("45 seconds")
      expect((yield* Fiber.join(fiber))._tag).toBe(delayed ? "Success" : "Failure")
      expect(attempts).toBe(delayed ? 2 : 1)
      const record = JSON.parse(readFileSync(join(home, "connector-state/teams/last-error.json"), "utf8"))
      expect(record).toMatchObject({ operation: "configured-snapshot", stage: "deadline" })
      expect(record.wallMs).toBeGreaterThanOrEqual(delayed ? 95_000 : 45_000)
    } finally {
      now.mockRestore()
      vi.unstubAllEnvs()
      rmSync(home, { recursive: true, force: true })
    }
  }).pipe(Effect.scoped))
}
