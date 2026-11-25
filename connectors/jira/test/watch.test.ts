import { describe, expect, it } from "@effect/vitest"
import { Effect, Fiber, Redacted, Stream } from "effect"
import { TestClock } from "effect/testing"
import type { GitHub } from "../src/GitHub.ts"
import type { JiraClient } from "../src/JiraClient.ts"
import { CredentialRejected, HttpFailure, RateLimited } from "../src/JiraError.ts"
import type { JiraSite } from "../src/Site.ts"
import type { IssueSnapshot } from "../src/Snapshot.ts"
import { encodeCursor } from "../src/Cursor.ts"
import { failureLimit, watch } from "../src/Watch.ts"

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
  comments: { start: 0, items: [] },
  values: {}
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

  it.effect("moves the Jira cursor when GitHub does not answer in time", () =>
    Effect.gen(function*() {
      const client: JiraClient["Service"] = {
        checkSite: () => Effect.succeed(site),
        resolveRoute: () => Effect.succeed(site),
        readIssue: () => Effect.succeed(snapshot),
        readJql: () => Effect.die("unused"),
        checkJql: () => Effect.die("unused")
      }
      const fiber = yield* watch({
        client,
        github: { ...unusedGitHub, searchPullRequests: () => Effect.never },
        site,
        target: { kind: "issue", key: "DEMO-7" },
        options: { fields: undefined, github: { repo: "acme/app", search: "DEMO-7", paths: [], since: undefined, sha: undefined } },
        githubToken: Redacted.make("ghp-not-a-real-token"),
        cursor: undefined
      }).pipe(Stream.take(1), Stream.runCollect, Effect.forkChild)
      yield* TestClock.adjust("30 seconds")
      const items = yield* Fiber.join(fiber)
      const cursor = items[0]?._tag === "Cursor" ? JSON.parse(items[0].cursor) : undefined
      expect(cursor).toMatchObject({ issueId: "10042", github: null, githubFailure: null })
    }))

  it.effect("reports a Jira outage once, after the failure limit, across reopened watches", () =>
    Effect.gen(function*() {
      let down = true
      const client: JiraClient["Service"] = {
        checkSite: () => Effect.succeed(site),
        resolveRoute: () => Effect.succeed(site),
        readIssue: () => down ? Effect.fail(new HttpFailure({ status: 503, reason: "Jira answered 503." })) : Effect.succeed(snapshot),
        readJql: () => Effect.die("unused"),
        checkJql: () => Effect.die("unused")
      }
      const run = (cursor: string) =>
        watch({
          client,
          github: unusedGitHub,
          site,
          target: { kind: "issue", key: "DEMO-7" },
          options: { fields: undefined, github: undefined },
          githubToken: undefined,
          cursor
        }).pipe(
          Stream.tap((item) => Effect.sync(() => items.push(item))),
          Stream.runDrain,
          Effect.flip,
          Effect.forkChild
        )
      const items: Array<unknown> = []
      const healthy = encodeCursor({
        v: 2,
        target: "issue",
        issueId: "10042",
        changelog: { consumed: 0, recent: [], lastCreated: "", atLast: [] },
        comments: { consumed: 0, recent: [], lastCreated: "", atLast: [] },
        github: null,
        githubFailure: null,
        githubFailures: 0
      })
      const first = yield* run(healthy)
      yield* TestClock.adjust(`${60 * (failureLimit - 1)} seconds`)
      expect((yield* Fiber.join(first))._tag).toBe("SourceFailed")
      expect(items.map((item: any) => item._tag === "Event" ? item.event.type : item._tag)).toEqual(["jira.unavailable", "Cursor"])
      const reported = (items[1] as { cursor: string }).cursor
      expect(JSON.parse(reported).outage).toEqual({ since: "1970-01-01T00:00:00.000Z" })

      items.length = 0
      const second = yield* run(reported)
      yield* TestClock.adjust(`${60 * (failureLimit - 1)} seconds`)
      expect((yield* Fiber.join(second))._tag).toBe("SourceFailed")
      expect(items).toEqual([])

      down = false
      const third = yield* watch({
        client,
        github: unusedGitHub,
        site,
        target: { kind: "issue", key: "DEMO-7" },
        options: { fields: undefined, github: undefined },
        githubToken: undefined,
        cursor: reported
      }).pipe(Stream.take(1), Stream.runCollect)
      expect(third[0]?._tag === "Cursor" ? JSON.parse(third[0].cursor).outage : "no cursor").toBeUndefined()
    }))

  it.effect.each([
    { myself: "accepts the credential", expected: "SourceFailed" },
    { myself: "rejects the credential", expected: "CredentialsRejected" }
  ])("treats a 403 on the issue as a source failure when /myself $myself", ({ expected, myself }) =>
    Effect.gen(function*() {
      let resolved = 0
      const client: JiraClient["Service"] = {
        checkSite: () => Effect.succeed(site),
        resolveRoute: () =>
          resolved++ === 0 || myself === "accepts the credential"
            ? Effect.succeed(site)
            : Effect.fail(new CredentialRejected({ status: 403 })),
        readIssue: () => Effect.fail(new HttpFailure({ status: 403, reason: "Jira answered 403." })),
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
      }).pipe(Stream.runDrain, Effect.flip, Effect.forkChild)
      yield* TestClock.adjust(`${60 * failureLimit} seconds`)
      expect((yield* Fiber.join(fiber))._tag).toBe(expected)
    }))
})

