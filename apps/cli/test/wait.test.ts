/// <reference types="bun" />
import { mkdtempSync, rmSync } from "node:fs"
import { afterAll, describe, expect, it } from "@effect/vitest"
import { Deferred, Duration, Effect, Exit, Fiber, Layer, Runtime, Scope } from "effect"
import { daemonServer, run } from "./harness.ts"

const directory = mkdtempSync("/tmp/xng-wait-")
afterAll(() => rmSync(directory, { recursive: true, force: true }))

const exitCode = (exit: Exit.Exit<unknown, unknown>) => {
  let code: number | undefined
  Runtime.defaultTeardown(exit, (c) => {
    code = c
  })
  return code
}

const waitThroughStop = (path: string, options: { readonly patience?: Duration.Duration; readonly restart: boolean }) =>
  Effect.gen(function*() {
    const first = yield* Scope.make()
    const arrived = yield* Deferred.make<void>()
    yield* Layer.buildWithScope(
      daemonServer(path, { Wait: () => Effect.andThen(Deferred.succeed(arrived, undefined), Effect.never) }),
      first
    )
    const waiting = yield* Effect.forkChild(
      Effect.promise(() => run(["wait", "sub_7f3k"], { socket: { path, serve: false }, ...options }))
    )
    yield* Deferred.await(arrived)
    yield* Scope.close(first, Exit.void)
    if (options.restart) {
      yield* Effect.sleep("300 millis")
      yield* Layer.build(daemonServer(path))
    }
    return yield* Fiber.join(waiting)
  }).pipe(Effect.scoped, Effect.runPromise)

describe("wait across a daemon restart", () => {
  it("keeps waiting when the daemon stops mid-wait and prints the wake from the restarted daemon", async () => {
    const result = await waitThroughStop(`${directory}/restart.sock`, { restart: true })
    expect(result.stderr).toBe("")
    expect(result.stdout).toContain("build failed")
    expect(exitCode(result.exit)).toBe(0)
  }, 20_000)

  it("gives up with one line and exit code 4 when the daemon does not come back", async () => {
    const result = await waitThroughStop(`${directory}/gone.sock`, { restart: false, patience: Duration.seconds(1) })
    expect(result.stdout).toBe("")
    expect(result.stderr).toMatch(/^The Exangelos daemon has not answered for 1s \(.+\), so this gave up\. Run `exangelos service status` to check it, then retry\.$/)
    expect(exitCode(result.exit)).toBe(4)
  }, 20_000)

  it("gives up on a daemon that accepts connections but never answers, with --json on stdout and one line on stderr", async () => {
    const path = `${directory}/hung.sock`
    const result = await Effect.gen(function*() {
      yield* Layer.build(daemonServer(path, { Wait: () => Effect.interrupt, ServiceStatus: () => Effect.never }))
      return yield* Effect.promise(() =>
        run(["wait", "sub_7f3k", "--json"], { socket: { path, serve: false }, patience: Duration.seconds(1) })
      )
    }).pipe(Effect.scoped, Effect.runPromise)
    expect(JSON.parse(result.stdout).error._tag).toBe("DaemonUnreachable")
    expect(result.stderr.split("\n")).toHaveLength(1)
    expect(result.stderr).toMatch(/^The Exangelos daemon has not answered for 1s/)
    expect(exitCode(result.exit)).toBe(4)
  }, 20_000)
})
