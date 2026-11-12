import { describe, expect, it } from "@effect/vitest"
import { Duration, Effect, Layer, Redacted } from "effect"
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
})
