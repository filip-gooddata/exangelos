import { describe, expect, it } from "@effect/vitest"
import { DateTime } from "effect"
import type { IssueCursor, JqlCursor } from "../src/Cursor.ts"
import { diffIssue, diffJql } from "../src/Diff.ts"
import type { History, IssueSnapshot } from "../src/Snapshot.ts"

const siteUrl = "https://acme.atlassian.net"
const at = (minute: number) => DateTime.makeUnsafe(`2026-11-12T10:${String(minute).padStart(2, "0")}:00Z`)
const mia = { accountId: "id-mia", displayName: "Mia" }

const change = (fieldId: string, fromString: string | null, toString: string | null) => ({
  field: fieldId,
  fieldId,
  from: null,
  fromString,
  to: null,
  toString
})

const histories: ReadonlyArray<History> = [
  { id: "100", created: at(0), author: mia, items: [change("status", "Open", "To Do")] },
  { id: "101", created: at(1), author: mia, items: [change("status", "To Do", "In Progress")] },
  { id: "102", created: at(3), author: mia, items: [change("assignee", null, "Ana"), change("labels", "", "backend")] }
]

const snapshot: IssueSnapshot = {
  id: "10042",
  key: "DEMO-7",
  summary: "Fix login",
  changelog: { start: 0, items: histories },
  comments: {
    start: 0,
    items: [
      { id: "200", created: at(0), author: mia, body: null },
      {
        id: "201",
        created: at(2),
        author: mia,
        body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Looks good" }] }] }
      }
    ]
  },
  values: {}
}

const seenUpTo100: IssueCursor = {
  v: 2,
  target: "issue",
  issueId: "10042",
  changelog: { consumed: 1, recent: ["100"], lastCreated: "2026-11-12T10:00:00.000Z", atLast: ["100"] },
  comments: { consumed: 1, recent: ["200"], lastCreated: "2026-11-12T10:00:00.000Z", atLast: ["200"] },
  github: null,
  githubFailure: null,
  githubFailures: 0
}

describe("diffIssue", () => {
  it("emits nothing on the first poll and positions the cursor at the end", () => {
    const poll = diffIssue({ siteUrl, previous: undefined, snapshot, observedAt: at(9) })
    expect(poll.events).toEqual([])
    expect(poll.cursor.changelog).toEqual({
      consumed: 3,
      recent: ["100", "101", "102"],
      lastCreated: "2026-11-12T10:03:00.000Z",
      atLast: ["102"]
    })
    expect(poll.cursor.comments).toEqual({
      consumed: 2,
      recent: ["200", "201"],
      lastCreated: "2026-11-12T10:02:00.000Z",
      atLast: ["201"]
    })
  })

  it("reports only the fields the fields option names, by id or by name", () => {
    const relabelled = {
      ...snapshot,
      changelog: {
        start: 0,
        items: [
          ...histories,
          { id: "103", created: at(4), author: mia, items: [{ ...change("fixVersions", null, "1.2"), field: "Fix Version" }] }
        ]
      }
    }
    const types = (fields: ReadonlyArray<string> | undefined) =>
      diffIssue({ siteUrl, previous: seenUpTo100, snapshot: relabelled, fields, observedAt: at(9) }).events
        .filter((event) => event.type === "field.changed")
        .map((event) => event.dedupeKey)
    expect(types(undefined)).toEqual(["10042:history:102:1", "10042:history:103:0"])
    expect(types(["resolution", "fixversions"])).toEqual(["10042:history:103:0"])
    expect(types(["fix version"])).toEqual(["10042:history:103:0"])
  })

  it("reports a watched field whose value changed without a changelog item, once", () => {
    const watched = { ...snapshot, values: { votes: "1", fixVersions: "[\"1.1\"]", labels: "[\"a, b\"]" } }
    const baseline = diffIssue({ siteUrl, previous: seenUpTo100, snapshot: watched, observedAt: at(9) })
    expect(baseline.cursor.values).toEqual(watched.values)
    const voted = {
      ...watched,
      changelog: {
        start: 0,
        items: [...histories, { id: "103", created: at(4), author: mia, items: [change("fixVersions", "1.1", "1.2")] }]
      },
      values: { votes: "null", fixVersions: "[\"1.2\"]", labels: "[\"a\",\"b\"]" }
    }
    const poll = diffIssue({ siteUrl, previous: baseline.cursor, snapshot: voted, observedAt: at(9) })
    expect(poll.events.filter((event) => event.type === "field.changed").map((event) => [event.dedupeKey, event.summary]))
      .toEqual([
        ["10042:history:103:0", "DEMO-7: fixVersions 1.1 → 1.2 by Mia"],
        ["10042:value:1:votes", "DEMO-7: votes 1 → (none)"],
        ["10042:value:2:labels", "DEMO-7: labels a, b → a, b"]
      ])
    expect(diffIssue({ siteUrl, previous: poll.cursor, snapshot: voted, observedAt: at(9) }).events).toEqual([])

    const unwatched = diffIssue({ siteUrl, previous: poll.cursor, snapshot: { ...voted, values: {} }, observedAt: at(9) })
    const rewatched = diffIssue({
      siteUrl,
      previous: unwatched.cursor,
      snapshot: { ...voted, values: { votes: "3" } },
      observedAt: at(9)
    })
    expect(unwatched.cursor.valueChanges).toBe(2)
    expect(rewatched.events.map((event) => event.dedupeKey)).toEqual([])
  })

  it("maps each change and comment to its event type, oldest first", () => {
    const poll = diffIssue({ siteUrl, previous: seenUpTo100, snapshot, observedAt: at(9) })
    expect(poll.events.map((event) => [event.type, event.dedupeKey])).toEqual([
      ["status.changed", "10042:history:101:0"],
      ["comment.added", "10042:comment:201"],
      ["assignee.changed", "10042:history:102:0"],
      ["field.changed", "10042:history:102:1"]
    ])
    expect(poll.events[0]?.summary).toBe("DEMO-7: status To Do → In Progress by Mia")
    expect(poll.events[1]?.summary).toBe("DEMO-7: comment by Mia: Looks good")
    expect(poll.events[1]?.link).toBe(`${siteUrl}/browse/DEMO-7?focusedCommentId=201`)
    expect(poll.events[3]?.link).toBe(`${siteUrl}/browse/DEMO-7`)
    expect(poll.events[0]?.occurredAt).toEqual(at(1))
  })

  it("emits nothing when the issue has not changed since the cursor", () => {
    const first = diffIssue({ siteUrl, previous: seenUpTo100, snapshot, observedAt: at(9) })
    const again = diffIssue({ siteUrl, previous: first.cursor, snapshot, observedAt: at(9) })
    expect(again.events).toEqual([])
    expect(again.cursor).toEqual(first.cursor)

    const otherIssue = diffIssue({ siteUrl, previous: { ...seenUpTo100, issueId: "99" }, snapshot, observedAt: at(9) })
    expect(otherIssue.events).toEqual([])
  })

  it("keeps a comment created at the same time as a deleted remembered one", () => {
    const deletedAnchor = {
      ...snapshot,
      changelog: { start: 0, items: [] },
      comments: { start: 0, items: [{ id: "202", created: at(0), author: mia, body: null }] }
    }
    const poll = diffIssue({ siteUrl, previous: seenUpTo100, snapshot: deletedAnchor, observedAt: at(9) })
    expect(poll.events.map((event) => event.dedupeKey)).toEqual(["10042:comment:202", "10042:comments-deleted:200:1:1"])
  })

  it("tells seen from unseen comments sharing a time after the remembered ones are deleted", () => {
    const sameTime = Array.from({ length: 51 }, (_, index) => ({ id: String(300 + index), created: at(4), author: mia, body: null }))
    const withComments = (items: typeof sameTime) => ({ ...snapshot, comments: { start: 0, items } })
    const baseline = diffIssue({ siteUrl, previous: undefined, snapshot: withComments(sameTime), observedAt: at(9) })
    const survivors = [sameTime[0]!, { id: "999", created: at(4), author: mia, body: null }]
    const poll = diffIssue({ siteUrl, previous: baseline.cursor, snapshot: withComments(survivors), observedAt: at(9) })
    expect(poll.events.map((event) => event.dedupeKey)).toEqual(["10042:comment:999", "10042:comments-deleted:350:51:2"])
  })
})

describe("diffJql", () => {
  const jql = "project = DEMO AND status = \"In Review\""
  const previous: JqlCursor = {
    v: 1,
    target: "jql",
    jql,
    members: [{ id: "1", key: "DEMO-1" }, { id: "2", key: "DEMO-2" }],
    edges: 3
  }
  const now = {
    jql,
    issues: [{ id: "2", key: "DEMO-2", summary: "Stays" }, { id: "3", key: "DEMO-3", summary: "Arrives" }]
  }

  it("reports an issue entering and one leaving, with keys that replay identically", () => {
    const poll = diffJql({ siteUrl, previous, snapshot: now, observedAt: at(5) })
    expect(poll.events.map((event) => [event.type, event.dedupeKey, event.summary])).toEqual([
      ["issue.entered", "jql:3:entered:4", "DEMO-3 entered the JQL result: Arrives"],
      ["issue.left", "jql:1:left:5", "DEMO-1 left the JQL result"]
    ])
    expect(poll.cursor.members).toEqual([{ id: "2", key: "DEMO-2" }, { id: "3", key: "DEMO-3" }])
    expect(poll.cursor.edges).toBe(5)

    const replay = diffJql({ siteUrl, previous, snapshot: now, observedAt: at(6) })
    expect(replay.events.map((event) => event.dedupeKey)).toEqual(["jql:3:entered:4", "jql:1:left:5"])

    const next = diffJql({ siteUrl, previous: poll.cursor, snapshot: now, observedAt: at(7) })
    expect(next.events).toEqual([])

    const edited = diffJql({ siteUrl, previous: poll.cursor, snapshot: { ...now, jql: "project = DEMO" }, observedAt: at(8) })
    expect(edited.events).toEqual([])
    expect(edited.cursor.edges).toBe(5)
  })
})
