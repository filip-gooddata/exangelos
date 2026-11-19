import { describe, expect, it } from "@effect/vitest"
import { Cause, Effect, Logger, References } from "effect"
import { Headers } from "effect/http"
import { logged } from "../src/Handlers.ts"

interface Record {
  readonly level: string
  readonly message: unknown
  readonly annotations: globalThis.Record<string, unknown>
  readonly failed: boolean
  readonly cause: string
}

const capture = (records: Array<Record>) =>
  Logger.make(({ cause, fiber, logLevel, message }) => {
    records.push({
      level: logLevel,
      message,
      annotations: fiber.getRef(References.CurrentLogAnnotations),
      failed: Cause.hasFails(cause),
      cause: Cause.pretty(cause)
    })
  })

const run = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.gen(function*() {
    const records: Array<Record> = []
    yield* Effect.exit(effect).pipe(
      Effect.provide(Logger.layer([capture(records)])),
      Effect.provideService(References.MinimumLogLevel, "Debug")
    )
    return records
  })

const caller = { headers: Headers.empty }

describe("request logging", () => {
  it.effect("logs one record per request with method, outcome and duration", () =>
    Effect.gen(function*() {
      const [ok, ...rest] = yield* run(logged("Subscribe", caller, Effect.succeed(1)))
      expect(rest).toEqual([])
      expect(ok.level).toBe("Info")
      expect(ok.annotations).toMatchObject({ method: "Subscribe", outcome: "ok", actor: "you" })
      expect(typeof ok.annotations.durationMs).toBe("number")
      expect(typeof ok.annotations.request).toBe("string")

      const [failed] = yield* run(logged("Show", caller, Effect.fail({ _tag: "SubscriptionNotFound" })))
      expect(failed.level).toBe("Warn")
      expect(failed.failed).toBe(true)
      expect(failed.annotations).toMatchObject({ method: "Show", outcome: "error", error: "SubscriptionNotFound" })

      const [polled] = yield* run(logged("List", caller, Effect.succeed([])))
      expect(polled.level).toBe("Debug")

      const [defect] = yield* run(logged("Ack", caller, Effect.die("broken")))
      expect(defect.level).toBe("Error")
      expect(defect.annotations).toMatchObject({ method: "Ack", outcome: "error", error: "defect" })
    }))

  it.effect("keeps a failure's fields and causes, without credentials or address extras", () =>
    Effect.gen(function*() {
      const failure = {
        _tag: "ConnectorUnavailable",
        connector: "jira",
        apiToken: "kept-out",
        details: { status: 503, headers: { Authorization: "nested-out" } },
        message: "fetching https://user:pass@jira.example/rest?jql=secret#top failed",
        cause: new Error("socket closed by https://proxy.example/?sig=x")
      }
      const [failed] = yield* run(logged("Subscribe", caller, Effect.fail(failure)))
      expect(failed.cause).toContain("ConnectorUnavailable: connector: jira, apiToken: [redacted]")
      expect(failed.cause).toContain("fetching https://jira.example/rest failed")
      expect(failed.cause).toContain("caused by Error: message: socket closed by https://proxy.example/")
      expect(failed.cause).toContain('details: {"status":503,"headers":{"Authorization":"[redacted]"}}')
      expect(failed.cause).not.toMatch(/kept-out|nested-out|user:pass|jql|sig=|#top/)
    }))
})
