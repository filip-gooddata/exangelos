import type { GitHub } from "../src/GitHub.ts"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Fiber, Redacted, Stream } from "effect"
import { TestClock } from "effect/testing"
import type { JiraClient } from "../src/JiraClient.ts"
import { CredentialRejected, RateLimited } from "../src/JiraError.ts"
import type { JiraSite } from "../src/Site.ts"
import type { IssueSnapshot } from "../src/Snapshot.ts"
import { watch } from "../src/Watch.ts"

const site: JiraSite = {
  url: "https://acme.atlassian.net",
  api: "https://acme.atlassian.net",
  email: "dev@example.com",
  token: Redacted.make("not-a-token")
}

const snapshot: IssueSnapshot = {
  id: "10042",
  key: "DEMO-7",
  summary: "Fix login",
  changelog: { start: 0, items: [] },
  comments: { start: 0, items: [] }
}

const unusedGitHub: GitHub["Service"] = {
  checkRepository: () => Effect.die("unused"),
  checkCommit: () => Effect.die("unused"),
  searchPullRequests: () => Effect.die("unused"),
  commits: () => Effect.die("unused"),
  releases: () => Effect.die("unused"),
  contains: () => Effect.die("unused")
}

describe("Watch", () => {
  it.effect("re-resolves the route once per run, even across a Retry-After wait", () =>
    Effect.gen(function*() {
      let resolutions = 0
      const answers = [
        Effect.succeed(snapshot),
        Effect.fail(new CredentialRejected({ status: 401 })),
        Effect.fail(new RateLimited({ retryAfterSeconds: 5 })),
        Effect.fail(new CredentialRejected({ status: 401 }))
      ]
      const client: JiraClient["Service"] = {
        checkSite: () => Effect.succeed(site),
        resolveRoute: () => Effect.sync(() => (resolutions += 1)).pipe(Effect.as(site)),
        readIssue: () => answers.shift() ?? Effect.die("read after the run should have ended"),
        readJql: () => Effect.die("unused"),
        checkJql: () => Effect.die("unused")
      }
      const fiber = yield* watch({
        client,
        github: unusedGitHub,
        site,
        target: { kind: "issue", key: "DEMO-7" },
        options: { fields: undefined, github: undefined },
        githubToken: undefined,
        cursor: undefined
      }).pipe(
        Stream.runCollect,
        Effect.flip,
        Effect.forkChild
      )
      yield* TestClock.adjust("60 seconds")
      yield* TestClock.adjust("5 seconds")
      const failure = yield* Fiber.join(fiber)
      expect(failure._tag).toBe("CredentialsRejected")
      expect(resolutions).toBe(2)
    }))
})
