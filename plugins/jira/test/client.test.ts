import { describe, expect, it } from "@effect/vitest"
import { Effect, Redacted } from "effect"
import { decodeIssueCursor, encodeCursor, issuePosition } from "../src/Cursor.ts"
import { diffIssue } from "../src/Diff.ts"
import { JiraClient } from "../src/JiraClient.ts"
import { makeSite } from "../src/Site.ts"
import { comment, history, jiraWith, page } from "./stubJira.ts"
import type { StubCall } from "./stubJira.ts"

const token = "ATATT-not-a-real-token-7f3a"
const site = makeSite({ url: "https://acme.atlassian.net/", email: "dev@example.com", token: Redacted.make(token) })

const statusChange = (from: string, to: string) => ({
  field: "status",
  fieldtype: "jira",
  fieldId: "status",
  from: "1",
  fromString: from,
  to: "2",
  toString: to
})

const changelog = [
  history(10001, "2026-11-12T09:00:00.000+0000", [statusChange("Open", "To Do")]),
  history(10002, "2026-11-12T09:10:00.000+0000", [statusChange("To Do", "In Progress")]),
  history(10003, "2026-11-12T09:20:00.000+0000", [statusChange("In Progress", "In Review")]),
  history(10004, "2026-11-12T09:30:00.000+0000", [statusChange("In Review", "In Progress")]),
  history(10005, "2026-11-12T09:40:00.000+0000", [statusChange("In Progress", "Done")])
]
const comments = [comment(20001, "2026-11-12T09:05:00.000+0000", "On it")]

/** Jira serving the issue two items per page, whatever maxResults asks for. */
const issueServer = (calls: Array<StubCall>) => (call: StubCall) => {
  calls.push(call)
  const startAt = Number(call.param("startAt") ?? "0")
  switch (call.path) {
    case "/rest/api/3/issue/DEMO-7":
      return { status: 200, body: { id: "10042", key: "DEMO-7", self: "x", fields: { summary: "Fix login" } } }
    case "/rest/api/3/issue/DEMO-7/changelog": {
      const { items, ...rest } = page(changelog, startAt, 2)
      return { status: 200, body: { ...rest, maxResults: 2, isLast: startAt + 2 >= changelog.length, values: items } }
    }
    case "/rest/api/3/issue/DEMO-7/comment": {
      const { items, ...rest } = page(comments, startAt, 2)
      return { status: 200, body: { ...rest, maxResults: 2, comments: items } }
    }
    default:
      return { status: 404, body: { errorMessages: ["Not found"], errors: {} } }
  }
}

describe("JiraClient", () => {
  it.effect("catches up over several changelog pages without missing or repeating an event", () => {
    const calls: Array<StubCall> = []
    return Effect.gen(function*() {
      const jira = yield* JiraClient
      const jiraSite = yield* site
      const stored = yield* decodeIssueCursor(encodeCursor({
        v: 1,
        target: "issue",
        issueId: "10042",
        changelog: { consumed: 1, lastId: "10001" },
        comments: { consumed: 1, lastId: "20001" }
      }))

      const snapshot = yield* jira.readIssue({ site: jiraSite, key: "DEMO-7", position: issuePosition(stored) })
      const poll = diffIssue({ siteUrl: jiraSite.url, previous: stored, snapshot })
      expect(poll.events.map((event) => event.dedupeKey)).toEqual([
        "10042:history:10002:0",
        "10042:history:10003:0",
        "10042:history:10004:0",
        "10042:history:10005:0"
      ])
      expect(poll.events.every((event) => event.type === "status.changed")).toBe(true)
      expect(poll.cursor.changelog).toEqual({ consumed: 5, lastId: "10005" })
      expect(calls.filter((call) => call.path.endsWith("/changelog")).map((call) => call.param("startAt"))).toEqual(
        ["0", "2", "4"]
      )

      const again = yield* jira.readIssue({ site: jiraSite, key: "DEMO-7", position: issuePosition(poll.cursor) })
      expect(diffIssue({ siteUrl: jiraSite.url, previous: poll.cursor, snapshot: again }).events).toEqual([])
    }).pipe(Effect.provide(jiraWith(issueServer(calls))))
  })

  it.effect("rejects the credential on 401 without the token in the error", () => {
    const calls: Array<StubCall> = []
    return Effect.gen(function*() {
      const jira = yield* JiraClient
      const jiraSite = yield* site
      const error = yield* Effect.flip(jira.readIssue({ site: jiraSite, key: "DEMO-7", position: undefined }))
      expect(error._tag).toBe("CredentialRejected")

      const authorization = calls[0]?.request.headers["authorization"] ?? ""
      expect(authorization.startsWith("Basic ")).toBe(true)
      const encoded = authorization.slice("Basic ".length)
      for (const text of [String(error), JSON.stringify(error), error.message, JSON.stringify(Object.entries(error))]) {
        expect(text).not.toContain(token)
        expect(text).not.toContain(encoded)
        expect(text.toLowerCase()).not.toContain("authorization")
      }
    }).pipe(
      Effect.provide(jiraWith((call) => {
        calls.push(call)
        return { status: 401, body: { errorMessages: ["Client must be authenticated to access this resource."] } }
      }))
    )
  })

  it.effect("refuses a site that is not Jira Cloud", () =>
    Effect.gen(function*() {
      const jira = yield* JiraClient
      const error = yield* Effect.flip(Effect.flatMap(site, jira.checkSite))
      expect(error._tag).toBe("UnsupportedSite")
    }).pipe(
      Effect.provide(jiraWith(() => ({ status: 200, body: { baseUrl: "https://jira.corp", deploymentType: "Server" } })))
    ))
})
