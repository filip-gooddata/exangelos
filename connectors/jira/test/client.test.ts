import { describe, expect, it } from "@effect/vitest"
import { DateTime, Effect, Redacted } from "effect"
import { decodeIssueCursor, encodeCursor, issuePosition } from "../src/Cursor.ts"
import { diffIssue } from "../src/Diff.ts"
import { JiraClient } from "../src/JiraClient.ts"
import { makeSite } from "../src/Site.ts"
import { comment, history, jiraWith, page } from "./stubJira.ts"
import type { StubCall } from "./stubJira.ts"

const token = "ATATT-not-a-real-token-7f3a"
const site = makeSite({ url: "https://acme.atlassian.net/", email: "dev@example.com", token: Redacted.make(token) })
const observedAt = DateTime.makeUnsafe("2026-11-12T11:00:00Z")

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
  it.effect.each([
    { case: "from its position", consumed: 1, startAts: ["0", "2", "4"] },
    { case: "from the start when items before its position were deleted", consumed: 60, startAts: ["10", "0", "2", "4"] }
  ])("catches up over several changelog pages $case, missing and repeating nothing", ({ consumed, startAts }) => {
    const calls: Array<StubCall> = []
    return Effect.gen(function*() {
      const jira = yield* JiraClient
      const jiraSite = yield* site
      const stored = yield* decodeIssueCursor(encodeCursor({
        v: 2,
        target: "issue",
        issueId: "10042",
        changelog: { consumed, recent: ["10001"], lastCreated: "2026-11-12T09:00:00.000Z", atLast: ["10001"] },
        comments: { consumed: 1, recent: ["20001"], lastCreated: "2026-11-12T09:05:00.000Z", atLast: ["20001"] },
        github: null,
        githubFailure: null,
        githubFailures: 0
      }))

      const snapshot = yield* jira.readIssue({ site: jiraSite, key: "DEMO-7", position: issuePosition(stored) })
      const poll = diffIssue({ siteUrl: jiraSite.url, previous: stored, snapshot, observedAt })
      expect(poll.events.map((event) => event.dedupeKey)).toEqual([
        "10042:history:10002:0",
        "10042:history:10003:0",
        "10042:history:10004:0",
        "10042:history:10005:0"
      ])
      expect(poll.events.every((event) => event.type === "status.changed")).toBe(true)
      expect(poll.cursor.changelog).toEqual({
        consumed: 5,
        recent: ["10001", "10002", "10003", "10004", "10005"],
        lastCreated: "2026-11-12T09:40:00.000Z",
        atLast: ["10005"]
      })
      expect(calls.filter((call) => call.path.endsWith("/changelog")).map((call) => call.param("startAt"))).toEqual(startAts)

      const again = yield* jira.readIssue({ site: jiraSite, key: "DEMO-7", position: issuePosition(poll.cursor) })
      expect(diffIssue({ siteUrl: jiraSite.url, previous: poll.cursor, snapshot: again, observedAt }).events).toEqual([])
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

  it.effect("reads the same field value whatever order Jira lists an object's keys in", () => {
    const votes = [
      { self: "https://acme.atlassian.net/votes", votes: 2, hasVoted: false },
      { hasVoted: false, votes: 2, self: "https://acme.atlassian.net/votes" }
    ]
    const widgets = [{ value: { z: 1, a: 2 } }, { value: { a: 2, z: 1 } }]
    let read = 0
    return Effect.gen(function*() {
      const jira = yield* JiraClient
      const jiraSite = yield* site
      const first = yield* jira.readIssue({ site: jiraSite, key: "DEMO-7", position: undefined, fields: ["votes", "labels", "customfield_1"] })
      const second = yield* jira.readIssue({
        site: jiraSite,
        key: "DEMO-7",
        position: undefined,
        fields: ["votes", "labels", "customfield_1"]
      })
      expect(first.values).toEqual(second.values)
      expect(first.values).toEqual({
        votes: "{\"hasVoted\":false,\"self\":\"https://acme.atlassian.net/votes\",\"votes\":2}",
        labels: "null",
        customfield_1: "{\"a\":2,\"z\":1}"
      })
    }).pipe(Effect.provide(jiraWith((call) => {
      if (call.path === "/rest/api/3/issue/DEMO-7") {
        const index = read++
        return {
          status: 200,
          body: { id: "10042", key: "DEMO-7", fields: { summary: "Fix login", votes: votes[index], customfield_1: widgets[index] } }
        }
      }
      return { status: 200, body: { startAt: 0, total: 0, maxResults: 100, isLast: true, values: [], comments: [] } }
    })))
  })

  it.effect("refuses a site that is not Jira Cloud", () =>
    Effect.gen(function*() {
      const jira = yield* JiraClient
      const error = yield* Effect.flip(Effect.flatMap(site, jira.checkSite))
      expect(error._tag).toBe("UnsupportedSite")
    }).pipe(
      Effect.provide(jiraWith(() => ({ status: 200, body: { baseUrl: "https://jira.corp", deploymentType: "Server" } })))
    ))

  it.effect("accepts a Cloud site once the credential reads /myself", () => {
    const paths: Array<string> = []
    return Effect.gen(function*() {
      const jira = yield* JiraClient
      yield* Effect.flatMap(site, jira.checkSite)
      expect(paths).toEqual(["/rest/api/3/serverInfo", "/rest/api/3/myself"])
    }).pipe(Effect.provide(jiraWith((call) => {
      paths.push(call.path)
      return call.path.endsWith("/myself")
        ? { status: 200, body: { accountId: "id-dev", displayName: "Dev" } }
        : { status: 200, body: { baseUrl: "https://acme.atlassian.net", deploymentType: "Cloud" } }
    })))
  })

  const searchServer = (total: number) => (call: StubCall) => {
    const from = Number(call.param("nextPageToken") ?? "0")
    const to = Math.min(total, from + 100)
    const issues = Array.from({ length: to - from }, (_, index) => ({
      id: String(from + index + 1),
      key: `DEMO-${from + index + 1}`,
      fields: { summary: "Issue" }
    }))
    return { status: 200, body: to < total ? { issues, nextPageToken: String(to), isLast: false } : { issues, isLast: true } }
  }

  it.effect("pages the whole JQL result and refuses one above the membership limit", () =>
    Effect.gen(function*() {
      const jiraSite = yield* site
      const whole = yield* Effect.flatMap(JiraClient, (jira) => jira.readJql({ site: jiraSite, jql: "project = DEMO" })).pipe(
        Effect.provide(jiraWith(searchServer(250)))
      )
      expect(whole.issues.map((issue) => issue.key).slice(-1)).toEqual(["DEMO-250"])
      expect(whole.issues).toHaveLength(250)

      const error = yield* Effect.flip(
        Effect.flatMap(JiraClient, (jira) => jira.readJql({ site: jiraSite, jql: "project = DEMO" })).pipe(
          Effect.provide(jiraWith(searchServer(1500)))
        )
      )
      expect(error._tag).toBe("JqlResultTooLarge")
    }))

  it.effect("keeps Jira's text out of the error for an unreadable time", () =>
    Effect.gen(function*() {
      const jira = yield* JiraClient
      const jiraSite = yield* site
      const error = yield* Effect.flip(jira.readIssue({ site: jiraSite, key: "DEMO-7", position: undefined }))
      expect(error._tag).toBe("DecodeFailure")
      expect(JSON.stringify(error)).not.toContain(token)
      expect(String(error)).not.toContain(token)
    }).pipe(Effect.provide(jiraWith((call) =>
      call.path.endsWith("/changelog")
        ? { status: 200, body: { startAt: 0, total: 1, values: [history(1, `soon ${token}`, [])] } }
        : { status: 200, body: { id: "10042", key: "DEMO-7", fields: { summary: "Fix login" } } }
    ))))
})
