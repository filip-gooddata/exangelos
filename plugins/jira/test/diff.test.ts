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
  }
}

const seenUpTo100: IssueCursor = {
  v: 1,
  target: "issue",
  issueId: "10042",
  changelog: { consumed: 1, recent: ["100"], lastCreated: "2026-11-12T10:00:00.000Z", atLast: ["100"] },
  comments: { consumed: 1, recent: ["200"], lastCreated: "2026-11-12T10:00:00.000Z", atLast: ["200"] }
}

describe("diffIssue", () => {
  it("emits nothing on the first poll and positions the cursor at the end", () => {
    const poll = diffIssue({ siteUrl, previous: undefined, snapshot })
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

  it("maps each change and comment to its event type, oldest first", () => {
    const poll = diffIssue({ siteUrl, previous: seenUpTo100, snapshot })
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
    const first = diffIssue({ siteUrl, previous: seenUpTo100, snapshot })
    const again = diffIssue({ siteUrl, previous: first.cursor, snapshot })
    expect(again.events).toEqual([])
    expect(again.cursor).toEqual(first.cursor)

    const otherIssue = diffIssue({ siteUrl, previous: { ...seenUpTo100, issueId: "99" }, snapshot })
    expect(otherIssue.events).toEqual([])
  })

  it("keeps a comment created at the same time as a deleted remembered one", () => {
    const deletedAnchor = {
      ...snapshot,
      changelog: { start: 0, items: [] },
      comments: { start: 0, items: [{ id: "202", created: at(0), author: mia, body: null }] }
    }
    const poll = diffIssue({ siteUrl, previous: seenUpTo100, snapshot: deletedAnchor })
    expect(poll.events.map((event) => event.dedupeKey)).toEqual(["10042:comment:202"])
  })

  it("tells seen from unseen comments sharing a time after the remembered ones are deleted", () => {
    const sameTime = Array.from({ length: 51 }, (_, index) => ({ id: String(300 + index), created: at(4), author: mia, body: null }))
    const withComments = (items: typeof sameTime) => ({ ...snapshot, comments: { start: 0, items } })
    const baseline = diffIssue({ siteUrl, previous: undefined, snapshot: withComments(sameTime) })
    const survivors = [sameTime[0]!, { id: "999", created: at(4), author: mia, body: null }]
    const poll = diffIssue({ siteUrl, previous: baseline.cursor, snapshot: withComments(survivors) })
    expect(poll.events.map((event) => event.dedupeKey)).toEqual(["10042:comment:999"])
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
