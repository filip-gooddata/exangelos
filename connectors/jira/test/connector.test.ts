import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Schema, Stream } from "effect"
import { readFileSync } from "node:fs"
import { Manifest } from "@exangelos/contracts"
import { ConnectorTest } from "@exangelos/connector-sdk"
import { connector } from "../src/JiraConnector.ts"
import { comment, history, jiraWith, page } from "./stubJira.ts"
import type { StubAnswer, StubCall } from "./stubJira.ts"

const token = "ATATT-not-a-real-token-7f3a"
const values = { site: "https://acme.atlassian.net", email: "dev@example.com", token }

const cloud: StubAnswer = { status: 200, body: { baseUrl: values.site, deploymentType: "Cloud" } }

const changelog = [
  history(10001, "2026-11-12T09:00:00.000+0000", [
    { field: "status", fieldId: "status", from: "1", fromString: "To Do", to: "3", toString: "In Progress" }
  ]),
  history(10002, "2026-11-12T09:20:00.000+0000", [
    { field: "assignee", fieldId: "assignee", from: null, fromString: null, to: "id-Ana", toString: "Ana" }
  ])
]
const comments = [comment(20001, "2026-11-12T09:10:00.000+0000", "On it")]

const jira = (answer: (call: StubCall) => StubAnswer) => {
  const tested = connector.layer.pipe(Layer.provide(jiraWith(answer)))
  return ConnectorTest.makeClient({ layer: tested })
}

const site = (call: StubCall): StubAnswer => {
  const startAt = Number(call.param("startAt") ?? "0")
  switch (call.path) {
    case "/rest/api/3/serverInfo":
      return cloud
    case "/rest/api/3/myself":
      return { status: 200, body: { accountId: "id-dev" } }
    case "/rest/api/3/issue/DEMO-7":
      return { status: 200, body: { id: "10042", key: "DEMO-7", fields: { summary: "Fix login" } } }
    case "/rest/api/3/issue/DEMO-7/changelog": {
      const { items, ...rest } = page(changelog, startAt, 100)
      return { status: 200, body: { ...rest, maxResults: 100, isLast: true, values: items } }
    }
    case "/rest/api/3/issue/DEMO-7/comment": {
      const { items, ...rest } = page(comments, startAt, 100)
      return { status: 200, body: { ...rest, maxResults: 100, comments: items } }
    }
    default:
      return { status: 404, body: { errorMessages: ["Issue does not exist or you do not have permission to see it."] } }
  }
}

const gateway = "/ex/jira/cloud-1"

/** A site that takes only a scoped token: 401 on the site URL, the same answers through the gateway. */
const scoped = (call: StubCall): StubAnswer => {
  if (call.path === "/rest/api/3/serverInfo") return cloud
  if (call.path === "/_edge/tenant_info") return { status: 200, body: { cloudId: "cloud-1" } }
  if (call.path.startsWith(gateway)) return site({ ...call, path: call.path.slice(gateway.length) })
  return { status: 401, body: { message: "Client must be authenticated" } }
}

/**
 * A cursor that has seen nothing on DEMO-7 since before its first history and comment. It is
 * version 1, as 0.1 wrote it, so every test that resumes from it also covers the migration.
 */
const before = JSON.stringify({
  v: 1,
  target: "issue",
  issueId: "10042",
  changelog: { consumed: 0, recent: [], lastCreated: "2026-11-12T08:00:00.000Z", atLast: [] },
  comments: { consumed: 0, recent: [], lastCreated: "2026-11-12T08:00:00.000Z", atLast: [] }
})

describe("Jira connector", () => {
  it.effect("hands over the catalogue", () =>
    Effect.gen(function*() {
      const client = yield* jira(site)
      const { catalogue } = yield* client.Handshake()
      expect(catalogue.eventTypes.map((eventType) => eventType.type)).toEqual([
        "status.changed",
        "comment.added",
        "comment.deleted",
        "assignee.changed",
        "field.changed",
        "issue.entered",
        "issue.left",
        "pull_request.found",
        "pull_request.state_changed",
        "commit.added",
        "release.found",
        "github.unavailable"
      ])
      expect(catalogue.eventTypes[5]?.description).toContain("enters and leaves the result between two polls is never seen")
      expect(catalogue.parameters.main).toBe("target")
      expect(catalogue.configuration.map((field) => [field._tag, field.key])).toEqual([
        ["Text", "site"],
        ["Text", "email"],
        ["Secret", "token"],
        ["Secret", "githubToken"]
      ])
      expect(catalogue.configuration.find((field) => field.key === "githubToken")?.required).toBe(false)
    }).pipe(Effect.scoped))

  it.effect.each([
    { input: { target: " demo-7 " }, subject: "issue:DEMO-7", parameters: { target: "DEMO-7", kind: "issue" } },
    {
      input: { target: "project = DEMO AND status = Open" },
      subject: "jql:project = DEMO AND status = Open",
      parameters: { target: "project = DEMO AND status = Open", kind: "jql" }
    }
  ])("describes $subject", ({ input, parameters, subject }) =>
    Effect.gen(function*() {
      const client = yield* jira(site)
      expect(yield* client.Describe({ parameters: input })).toMatchObject({ _tag: "Described", subject, parameters })
    }).pipe(Effect.scoped))

  it.effect("refuses a target that is not an issue key when the kind says issue", () =>
    Effect.gen(function*() {
      const client = yield* jira(site)
      const described = yield* client.Describe({ parameters: { target: "status = Open", kind: "issue" } })
      expect(described).toEqual({ _tag: "Invalid", reason: "\"status = Open\" is not an issue key such as PROJECT-123." })
    }).pipe(Effect.scoped))

  it.effect("refuses a JQL query Jira cannot run", () =>
    Effect.gen(function*() {
      const client = yield* jira((call) =>
        call.path === "/rest/api/3/search/jql" ? { status: 400, body: { errorMessages: ["Error in JQL"] } } : site(call)
      )
      yield* client.Configure({ values })
      const described = yield* client.Describe({ parameters: { target: "project =", kind: "jql" } })
      expect(described).toEqual({ _tag: "Invalid", reason: "Jira refused the JQL query. Check its syntax and the fields it names." })
    }).pipe(Effect.scoped))

  it.effect("rejects a credential Jira answers 401 to, without repeating the token", () =>
    Effect.gen(function*() {
      const client = yield* jira((call) =>
        call.path === "/rest/api/3/myself" ? { status: 401, body: { message: "Client must be authenticated" } } : cloud
      )
      const result = yield* client.Configure({ values })
      expect(result).toMatchObject({ _tag: "Rejected", reason: expect.stringContaining("rejected the email and API token") })
      expect(JSON.stringify(result)).not.toContain(token)
    }).pipe(Effect.scoped))

  it.effect.each([
    { token: "a classic token on the site URL", answer: site, rest: "/rest/api/3/" },
    { token: "a scoped token through the gateway", answer: scoped, rest: `${gateway}/rest/api/3/` }
  ])("emits what changed since the cursor with $token, then moves the cursor past it", ({ answer, rest }) => {
    const calls: Array<StubCall> = []
    return Effect.gen(function*() {
      const client = yield* jira((call) => {
        calls.push(call)
        return answer(call)
      })
      expect(yield* client.Configure({ values })).toEqual({ _tag: "Accepted" })
      const items = yield* client.Watch({ parameters: { target: "DEMO-7", kind: "issue" }, eventTypes: [], cursor: before })
        .pipe(Stream.take(4), Stream.runCollect)

      expect(items.map((item) => item._tag === "Event" ? item.event.type : item._tag)).toEqual([
        "status.changed",
        "comment.added",
        "assignee.changed",
        "Cursor"
      ])
      expect(items[1]).toMatchObject({
        event: {
          summary: "DEMO-7: comment by Ana: On it",
          dedupeKey: "10042:comment:20001",
          link: "https://acme.atlassian.net/browse/DEMO-7?focusedCommentId=20001"
        }
      })
      const moved = items[3]?._tag === "Cursor" ? JSON.parse(items[3].cursor) : undefined
      expect(moved).toMatchObject({ issueId: "10042", changelog: { consumed: 2 }, comments: { consumed: 1 } })
      expect(JSON.stringify(items)).not.toContain(token)
      expect(calls.filter((call) => call.path.includes("/issue/")).every((call) => call.path.startsWith(rest))).toBe(true)
      expect(calls.filter((call) => call.path === "/_edge/tenant_info").map((call) => call.request.headers.authorization))
        .toEqual(answer === scoped ? [undefined, undefined] : [])
    }).pipe(Effect.scoped)
  })

  it.effect("ends when the issue is gone", () =>
    Effect.gen(function*() {
      const client = yield* jira(site)
      yield* client.Configure({ values })
      const items = yield* client.Watch({ parameters: { target: "GONE-1" }, eventTypes: [] }).pipe(Stream.runCollect)
      expect(items).toEqual([{ _tag: "End", reason: "The issue GONE-1 no longer exists or this account cannot see it." }])
    }).pipe(Effect.scoped))

  it.effect("reports a revoked token that Jira answers with 404 as a rejected credential", () =>
    Effect.gen(function*() {
      let revoked = false
      let checks = 0
      const client = yield* jira((call) => {
        if (!revoked) return site(call)
        if (call.path === "/rest/api/3/serverInfo") return cloud
        if (call.path === "/_edge/tenant_info") return { status: 200, body: { cloudId: "cloud-1" } }
        if (call.path === "/rest/api/3/myself" && checks++ === 0) return site(call)
        if (call.path.endsWith("/rest/api/3/myself")) return { status: 401, body: { message: "Client must be authenticated" } }
        return { status: 404, body: { errorMessages: ["Issue does not exist or you do not have permission to see it."] } }
      })
      yield* client.Configure({ values })
      revoked = true
      const failure = yield* client.Watch({ parameters: { target: "DEMO-7" }, eventTypes: [] }).pipe(
        Stream.runCollect,
        Effect.flip
      )
      expect(failure).toMatchObject({ _tag: "CredentialsRejected" })
    }).pipe(Effect.scoped))

  it.effect("calls a gateway 403 on /myself a rejected credential, at configure and while watching", () =>
    Effect.gen(function*() {
      let denied = false
      const client = yield* jira((call) =>
        denied && call.path.startsWith(gateway) ? { status: 403, body: { message: "Forbidden" } } : scoped(call)
      )
      yield* client.Configure({ values })
      denied = true
      const failure = yield* client.Watch({ parameters: { target: "DEMO-7" }, eventTypes: [] }).pipe(
        Stream.runCollect,
        Effect.flip
      )
      expect(failure).toEqual(
        expect.objectContaining({ _tag: "CredentialsRejected", reason: "Jira rejected the email and API token (HTTP 403)." })
      )
      expect(yield* client.Configure({ values })).toMatchObject({ _tag: "Rejected", reason: expect.stringContaining("HTTP 403") })
    }).pipe(Effect.scoped))

  it.effect("does not call a credential rejected when the site cannot tell its cloud id", () =>
    Effect.gen(function*() {
      const client = yield* jira((call) => call.path === "/_edge/tenant_info" ? { status: 503 } : scoped(call))
      const result = yield* client.Configure({ values })
      expect(result).toMatchObject({ _tag: "Rejected", reason: expect.stringContaining("HTTP 503") })
    }).pipe(Effect.scoped))

  it.effect("ends when Jira refuses the JQL query", () =>
    Effect.gen(function*() {
      const client = yield* jira((call) =>
        call.path.startsWith("/rest/api/3/search") ? { status: 400, body: { errorMessages: ["Error in JQL"] } } : site(call)
      )
      yield* client.Configure({ values })
      const items = yield* client.Watch({ parameters: { target: "project =", kind: "jql" }, eventTypes: [] })
        .pipe(Stream.runCollect)
      expect(items).toEqual([{ _tag: "End", reason: "Jira refused the JQL query (HTTP 400). Check the query and subscribe again." }])
    }).pipe(Effect.scoped))

  it.effect("starts from the current state when the cursor is unreadable", () =>
    Effect.gen(function*() {
      const client = yield* jira(site)
      yield* client.Configure({ values })
      const items = yield* client.Watch({ parameters: { target: "DEMO-7" }, eventTypes: [], cursor: "{\"v\":0}" })
        .pipe(Stream.take(1), Stream.runCollect)
      expect(items.map((item) => item._tag)).toEqual(["Cursor"])
    }).pipe(Effect.scoped))

  it.effect("refuses GitHub signals it cannot watch", () =>
    Effect.gen(function*() {
      const client = yield* jira(site)
      yield* client.Configure({ values })
      const reasons = yield* Effect.forEach([
        { target: "DEMO-7", githubRepo: "acme/app" },
        { target: "project = DEMO", githubRepo: "acme/app" },
        { target: "DEMO-7", githubPaths: "src" },
        { target: "DEMO-7", githubRepo: "acme/app", sha: "not-a-sha" }
      ], (parameters) => client.Describe({ parameters }).pipe(Effect.map((described) => (described as { reason?: string }).reason)))
      expect(reasons).toEqual([
        "githubRepo needs a GitHub token: configure the jira connector with githubToken.",
        "githubRepo watches one issue: give an issue key as the target.",
        "githubSearch, githubPaths, since and sha need githubRepo.",
        "sha \"not-a-sha\" is not a commit SHA of 7 to 40 hex digits."
      ])
    }).pipe(Effect.scoped))

  it.effect("watches GitHub signals next to the issue with githubToken, and hands it only to GitHub", () => {
    const calls: Array<StubCall> = []
    let merged = false
    const githubToken = "ghp-not-a-real-token-91c2"
    return Effect.gen(function*() {
      const client = yield* jira((call) => {
        calls.push(call)
        if (!call.request.url.startsWith("https://api.github.com/")) return site(call)
        switch (call.path) {
          case "/repos/acme/app":
          case "/repos/acme/app/commits/abc1234":
            return { status: 200, body: {} }
          case "/search/issues":
            return {
              status: 200,
              body: {
                items: [{
                  number: 5,
                  title: "DEMO-7 fix login",
                  state: merged ? "closed" : "open",
                  html_url: "https://github.com/acme/app/pull/5",
                  updated_at: merged ? "2026-11-20T09:40:00Z" : "2026-11-20T09:00:00Z",
                  user: { login: "ana" },
                  pull_request: { merged_at: merged ? "2026-11-20T09:40:00Z" : null }
                }]
              }
            }
          case "/repos/acme/app/releases":
            return { status: 200, body: [] }
          default:
            return { status: 404, body: { message: "Not Found" } }
        }
      })
      yield* client.Configure({ values: { ...values, githubToken } })
      const parameters = {
        target: "DEMO-7",
        fields: "[\"resolution\",\"fixVersions\"]",
        githubRepo: "acme/app",
        sha: "ABC1234"
      }
      const described = yield* client.Describe({ parameters })
      expect(described).toMatchObject({
        _tag: "Described",
        subject: "issue:DEMO-7",
        parameters: { target: "DEMO-7", kind: "issue", fields: ["resolution", "fixVersions"], githubRepo: "acme/app", sha: "abc1234" }
      })
      const first = yield* client.Watch({ parameters, eventTypes: [], cursor: before }).pipe(Stream.take(4), Stream.runCollect)
      expect(first.map((item) => item._tag === "Event" ? item.event.type : item._tag)).toEqual([
        "status.changed",
        "comment.added",
        "assignee.changed",
        "Cursor"
      ])
      const cursor = first[3]?._tag === "Cursor" ? first[3].cursor : ""
      expect(JSON.parse(cursor)).toMatchObject({
        v: 2,
        github: { repo: "acme/app", search: "DEMO-7", pullRequests: [{ number: 5, state: "open" }] }
      })

      merged = true
      const second = yield* client.Watch({ parameters, eventTypes: [], cursor }).pipe(Stream.take(2), Stream.runCollect)
      expect(second[0]).toMatchObject({
        _tag: "Event",
        event: { type: "pull_request.state_changed", summary: "DEMO-7: acme/app#5 open → merged: DEMO-7 fix login" }
      })
      const search = calls.find((call) => call.path === "/search/issues")
      expect(search?.param("q")).toBe("DEMO-7 repo:acme/app is:pr")
      const github = calls.filter((call) => call.request.url.startsWith("https://api.github.com/"))
      expect(github.every((call) => call.request.headers.authorization === `Bearer ${githubToken}`)).toBe(true)
      const jiraCalls = calls.filter((call) => !call.request.url.startsWith("https://api.github.com/"))
      expect(jiraCalls.some((call) => JSON.stringify(call.request.headers).includes(githubToken))).toBe(false)
      expect(JSON.stringify([...first, ...second])).not.toContain(githubToken)
    }).pipe(Effect.scoped)
  })

  it.effect("keeps reporting Jira when GitHub refuses githubToken, and says so once per outage", () =>
    Effect.gen(function*() {
      let refused = true
      const client = yield* jira((call) => {
        if (!call.request.url.startsWith("https://api.github.com/")) return site(call)
        if (refused) return { status: 401, body: { message: "Bad credentials" } }
        return { status: 200, body: { items: [] } }
      })
      yield* client.Configure({ values: { ...values, githubToken: "ghp-revoked" } })
      const parameters = { target: "DEMO-7", githubRepo: "acme/app" }
      const first = yield* client.Watch({ parameters, eventTypes: [], cursor: before }).pipe(Stream.take(5), Stream.runCollect)
      expect(first.map((item) => item._tag === "Event" ? item.event.type : item._tag)).toEqual([
        "status.changed",
        "comment.added",
        "assignee.changed",
        "github.unavailable",
        "Cursor"
      ])
      expect(first[3]).toMatchObject({
        event: {
          summary: "DEMO-7: GitHub signals for acme/app stopped: GitHub rejected githubToken (HTTP 401). Configure a token that can read acme/app.",
          dedupeKey: "10042:github:unavailable:1"
        }
      })
      const failing = first[4]?._tag === "Cursor" ? first[4].cursor : ""

      refused = false
      const recovered = yield* client.Watch({ parameters, eventTypes: [], cursor: failing }).pipe(Stream.take(1), Stream.runCollect)
      const healthy = recovered[0]?._tag === "Cursor" ? recovered[0].cursor : ""
      expect(JSON.parse(healthy)).toMatchObject({ githubFailure: null, githubFailures: 1, github: { repo: "acme/app" } })

      refused = true
      const again = yield* client.Watch({ parameters, eventTypes: [], cursor: healthy }).pipe(Stream.take(2), Stream.runCollect)
      expect(again[0]).toMatchObject({ event: { type: "github.unavailable", dedupeKey: "10042:github:unavailable:2" } })
      const stillFailing = again[1]?._tag === "Cursor" ? again[1].cursor : ""
      const moved = yield* client.Watch({ parameters: { ...parameters, githubRepo: "acme/other" }, eventTypes: [], cursor: stillFailing })
        .pipe(Stream.take(1), Stream.runCollect)
      expect(moved[0]).toMatchObject({ event: { type: "github.unavailable", dedupeKey: "10042:github:unavailable:3" } })
    }).pipe(Effect.scoped))

  it("declares an entry the manifest schema accepts", () => {
    const manifest = Schema.decodeUnknownSync(Manifest.Manifest)(
      JSON.parse(readFileSync(new URL("../connector.json", import.meta.url), "utf8"))
    )
    expect(manifest).toEqual({ name: "jira", version: "0.2.0", entry: { _tag: "Bundle", path: "dist/main.js" }, icon: "icon.svg" })
  })
})
