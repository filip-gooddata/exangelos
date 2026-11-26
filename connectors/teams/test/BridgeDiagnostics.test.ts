import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Sink, Stream } from "effect"
import { ChildProcessSpawner } from "effect/process"
import { TestClock } from "effect/testing"
import { vi } from "vitest"
import { childDetail, recordFailure } from "../src/LastError.ts"
import { ConnectorTest } from "@exangelos/connector-sdk"
import { make } from "../src/Teams.ts"
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
    symlinkSync(target, join(home, "diagnostics"))
    recordFailure("resolve", { wall: Date.now(), monotonic: performance.now() }, { stage: "spawn" })
    expect(existsSync(join(target, "teams"))).toBe(false)
  } finally {
    vi.unstubAllEnvs()
    rmSync(home, { recursive: true, force: true })
  }
})

for (const [delayed, pythonDeadline] of [[false, false], [true, false], [true, true]] as const) {
  it.effect(`${pythonDeadline ? "bridge" : "outer"} deadline with ${delayed ? "late" : "on-time"} timer handling`, () => Effect.gen(function*() {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "teams-deadline-")))
    vi.stubEnv("EXANGELOS_HOME", home)
    const now = vi.spyOn(Date, "now")
    try {
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      let attempts = 0
      const scope = "a".repeat(64)
      const request = { scope, includeMessagePreview: false }
      const spawner = ChildProcessSpawner.make(() => Effect.gen(function*() {
        if (++attempts === 1) {
          yield* Deferred.succeed(started, undefined)
          if (!pythonDeadline) return yield* Effect.never
          yield* Deferred.await(release)
        }
        const output = Stream.make(new TextEncoder().encode(JSON.stringify({ ...request, messages: [] })))
        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1), exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(pythonDeadline && attempts === 1 ? 34 : 0)),
          isRunning: Effect.succeed(false), kill: () => Effect.void, stdin: Sink.drain,
          stdout: output, stderr: Stream.empty, all: output, getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty, unref: Effect.succeed(Effect.void)
        })
      }))
      const fiber = yield* localSource.read(request, Effect.succeed(true)).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.result, Effect.forkScoped
      )
      yield* Deferred.await(started)
      now.mockReturnValue(Date.now() + (delayed ? 95_000 : 45_000))
      if (pythonDeadline) yield* Deferred.succeed(release, undefined)
      else yield* TestClock.adjust("45 seconds")
      expect((yield* Fiber.join(fiber))._tag).toBe(delayed ? "Success" : "Failure")
      expect(attempts).toBe(delayed ? 2 : 1)
      const record = JSON.parse(readFileSync(join(home, "diagnostics/teams/last-error.json"), "utf8"))
      expect(record).toMatchObject({ operation: "configured-snapshot", stage: pythonDeadline ? "exit" : "deadline" })
      expect(record.wallMs).toBeGreaterThanOrEqual(delayed ? 95_000 : 45_000)
    } finally {
      now.mockRestore()
      vi.unstubAllEnvs()
      rmSync(home, { recursive: true, force: true })
    }
  }).pipe(Effect.scoped))
}

it.effect("does not spawn a retry after cache authorization is revoked", () => Effect.gen(function*() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "teams-revoked-")))
  vi.stubEnv("EXANGELOS_HOME", home)
  const now = vi.spyOn(Date, "now")
  try {
    const started = yield* Deferred.make<void>()
    let attempts = 0
    const spawner = ChildProcessSpawner.make(() => Effect.gen(function*() {
      attempts++
      if (attempts > 1) return yield* Effect.die("unexpected child after revocation")
      yield* Deferred.succeed(started, undefined)
      return yield* Effect.never
    }))
    const client = yield* ConnectorTest.makeClient(make(localSource)).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner))
    yield* client.Configure({ values: { subscriptionAccess: "persisted-cache" } })
    const fiber = yield* client.Watch({ parameters: { selection: "scope-" + "a".repeat(64) }, eventTypes: [] })
      .pipe(Stream.runDrain, Effect.result, Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner), Effect.forkScoped)
    yield* Deferred.await(started)
    yield* client.Configure({ values: { subscriptionAccess: "disabled" } })
    now.mockReturnValue(Date.now() + 95_000)
    yield* TestClock.adjust("45 seconds")
    expect((yield* Fiber.join(fiber))._tag).toBe("Failure")
    expect(attempts).toBe(1)
  } finally {
    now.mockRestore()
    vi.unstubAllEnvs()
    rmSync(home, { recursive: true, force: true })
  }
}).pipe(Effect.scoped))
