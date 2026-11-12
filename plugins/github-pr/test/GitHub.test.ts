import { describe, expect, it } from "@effect/vitest"
import { Duration, Effect, Fiber, Layer, Redacted } from "effect"
import { TestClock } from "effect/testing"
import * as GitHub from "../src/GitHub.ts"
import * as Stub from "./stubGitHub.ts"

const ref = { owner: "acme", repo: "api", number: 7 }
const connection = (host = "github.com"): GitHub.Connection => ({ host, token: Redacted.make("ghp_stubbed") })

const fetch = (answers: ReadonlyArray<Stub.Answer>, host?: string) =>
  Effect.gen(function*() {
    const stub = yield* Stub.make(answers)
    const result = yield* GitHub.GitHub.use((github) => github.pullRequest(connection(host), ref, undefined)).pipe(
      Effect.result,
      Effect.provide(Layer.provide(GitHub.layer, stub.layer))
    )
    return { result, sent: yield* stub.sent }
  })

describe("GitHub", () => {
  it.effect("reads a pull request with one query to the Enterprise host it is given", () =>
    Effect.gen(function*() {
      const { result, sent } = yield* fetch(
        [Stub.pullRequest({ checks: [{ id: "CR_1", name: "build", conclusion: "FAILURE" }] })],
        "github.acme.dev"
      )

      expect(result._tag).toBe("Success")
      if (result._tag !== "Success") return
      expect(result.success.snapshot).toMatchObject({
        head: "a".repeat(40),
        requiredChecks: ["build"],
        checks: [{ name: "build", outcome: "failed", required: true }]
      })
      expect(sent.map((s) => [s.url, s.authorization, s.variables])).toEqual([
        ["https://github.acme.dev/api/graphql", "Bearer ghp_stubbed", { owner: "acme", repo: "api", number: 7 }]
      ])
    }))

  it.effect("tells a refused token from a missing repository, without the token in the reason", () =>
    Effect.gen(function*() {
      const refused = yield* fetch([{ status: 401, body: { message: "Bad credentials for ghp_stubbed" } }])
      const missing = yield* fetch([Stub.notFound("acme", "api")])

      expect(refused.result).toMatchObject({ _tag: "Failure", failure: { _tag: "Unauthorized" } })
      expect(missing.result).toMatchObject({ _tag: "Failure", failure: { _tag: "NotFound" } })
      expect(JSON.stringify([refused.result, missing.result])).not.toContain("ghp_stubbed")
    }))

  it.effect("reads how long a secondary rate limit asks it to wait", () =>
    Effect.gen(function*() {
      const { result } = yield* fetch([Stub.secondaryLimit])

      expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "RateLimited" } })
      if (result._tag === "Failure" && result.failure._tag === "RateLimited") {
        expect(Duration.toSeconds(result.failure.retryAfter)).toBe(30)
      }
    }))

  it.effect("reads back past ten pages, waiting out an exhausted quota and a secondary limit between them", () =>
    Effect.gen(function*() {
      const at = (n: number) => ({ id: `IC_${n}`, login: "ana", body: `note ${n}`, createdAt: `2026-11-12T01:${String(n).padStart(2, "0")}:00Z` })
      const older = (n: number) => n > 1 ? `before-${n}` : null
      const stub = yield* Stub.make([
        Stub.pullRequest({ comments: [at(12)], olderComments: "before-12", headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "60" } }),
        Stub.secondaryLimit,
        ...[11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1].map((n) => Stub.commentsPage([at(n)], older(n)))
      ])
      const since: GitHub.Since = { reviews: null, comments: "2026-11-12T00:00:00Z", threads: null }
      const fiber = yield* GitHub.GitHub.use((github) => github.pullRequest(connection(), ref, since)).pipe(
        Effect.provide(Layer.provide(GitHub.layer, stub.layer)),
        Effect.forkChild
      )

      yield* TestClock.adjust("59 seconds")
      expect(yield* stub.sent).toHaveLength(1)
      yield* TestClock.adjust("1 second")
      expect(yield* stub.sent).toHaveLength(2)
      yield* TestClock.adjust("30 seconds")
      const { snapshot } = yield* Fiber.join(fiber)

      expect(snapshot.comments.map((c) => c.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((n) => `IC_${n}`))
      expect((yield* stub.sent).map((s) => s.variables.comments)).toEqual([
        undefined,
        "before-12",
        "before-12",
        ...[11, 10, 9, 8, 7, 6, 5, 4, 3, 2].map((n) => `before-${n}`)
      ])
    }))
})
