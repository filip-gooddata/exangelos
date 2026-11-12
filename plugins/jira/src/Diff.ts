import { DateTime } from "effect"
import type { IssueCursor, JqlCursor } from "./Cursor.ts"
import { browseLink } from "./Site.ts"
import type { Comment, FieldChange, History, IssueSnapshot, JqlSnapshot, ListPosition, ListTail, Person } from "./Snapshot.ts"

export const eventTypes = {
  statusChanged: "status.changed",
  commentAdded: "comment.added",
  assigneeChanged: "assignee.changed",
  fieldChanged: "field.changed",
  issueEntered: "issue.entered",
  issueLeft: "issue.left"
} as const
export type JiraEventType = typeof eventTypes[keyof typeof eventTypes]

/** One event as the Watch stream reports it, before the SDK wraps it. */
export interface JiraEvent {
  readonly type: JiraEventType
  readonly occurredAt: DateTime.Utc
  readonly summary: string
  readonly payload: unknown
  readonly link: string
  readonly dedupeKey: string
}

export interface IssuePoll {
  readonly events: ReadonlyArray<JiraEvent>
  readonly cursor: IssueCursor
}

export interface JqlPoll {
  readonly events: ReadonlyArray<JiraEvent>
  readonly cursor: JqlCursor
}

const clip = (text: string, length: number): string => text.length <= length ? text : `${text.slice(0, length - 1)}…`

const shown = (value: string | null): string => value === null || value === "" ? "(none)" : clip(value, 80)

const nameOf = (author: Person | undefined): string => author?.displayName ?? "someone"

/** The plain text of an Atlassian Document Format node, for summaries. */
const documentText = (node: unknown): string => {
  if (typeof node !== "object" || node === null) return ""
  const text = "text" in node && typeof node.text === "string" ? node.text : ""
  const content = "content" in node && Array.isArray(node.content) ? node.content : []
  const inner = content.map(documentText).filter((part) => part !== "").join(" ")
  return [text, inner].filter((part) => part !== "").join(" ")
}

const advance = <A extends { readonly id: string }>(
  previous: ListPosition | undefined,
  tail: ListTail<A>
): { readonly fresh: ReadonlyArray<A>; readonly position: ListPosition } => {
  const lastId = previous?.lastId ?? ""
  const fresh = previous === undefined
    ? []
    : tail.items.filter((item) => lastId === "" || Number(item.id) > Number(lastId))
  const newest = tail.items.reduce(
    (highest, item) => highest === "" || Number(item.id) > Number(highest) ? item.id : highest,
    lastId
  )
  return { fresh, position: { consumed: tail.start + tail.items.length, lastId: newest } }
}

const typeOfChange = (change: FieldChange): JiraEventType => {
  switch (change.fieldId ?? change.field.toLowerCase()) {
    case "status":
      return eventTypes.statusChanged
    case "assignee":
      return eventTypes.assigneeChanged
    default:
      return eventTypes.fieldChanged
  }
}

const historyEvents = (snapshot: IssueSnapshot, link: string, history: History): ReadonlyArray<JiraEvent> =>
  history.items.map((change, index) => {
    const type = typeOfChange(change)
    const what = type === eventTypes.fieldChanged ? change.field : type === eventTypes.statusChanged ? "status" : "assignee"
    return {
      type,
      occurredAt: history.created,
      summary: `${snapshot.key}: ${what} ${shown(change.fromString)} → ${shown(change.toString)} by ${
        nameOf(history.author)
      }`,
      payload: {
        issue: { id: snapshot.id, key: snapshot.key, summary: snapshot.summary },
        historyId: history.id,
        author: history.author ?? null,
        field: change.field,
        fieldId: change.fieldId ?? null,
        from: change.from,
        fromString: change.fromString,
        to: change.to,
        toString: change.toString
      },
      link,
      dedupeKey: `${snapshot.id}:history:${history.id}:${index}`
    }
  })

const commentEvent = (snapshot: IssueSnapshot, siteUrl: string, comment: Comment): JiraEvent => {
  const text = documentText(comment.body)
  return {
    type: eventTypes.commentAdded,
    occurredAt: comment.created,
    summary: `${snapshot.key}: comment by ${nameOf(comment.author)}${text === "" ? "" : `: ${clip(text, 140)}`}`,
    payload: {
      issue: { id: snapshot.id, key: snapshot.key, summary: snapshot.summary },
      commentId: comment.id,
      author: comment.author ?? null,
      body: comment.body ?? null
    },
    link: `${browseLink(siteUrl, snapshot.key)}?focusedCommentId=${encodeURIComponent(comment.id)}`,
    dedupeKey: `${snapshot.id}:comment:${comment.id}`
  }
}

/**
 * The events between the previous cursor and this snapshot of an issue, oldest first, and the
 * cursor after them. Without a previous cursor the poll is a baseline: no events, cursor at the end.
 * Items at or below the cursor's last id are dropped, so replaying a poll emits nothing twice.
 */
export const diffIssue = (input: {
  readonly siteUrl: string
  readonly previous: IssueCursor | undefined
  readonly snapshot: IssueSnapshot
}): IssuePoll => {
  const { previous, siteUrl, snapshot } = input
  const link = browseLink(siteUrl, snapshot.key)
  const changelog = advance(previous?.changelog, snapshot.changelog)
  const comments = advance(previous?.comments, snapshot.comments)
  const events = [
    ...changelog.fresh.flatMap((history) => historyEvents(snapshot, link, history)),
    ...comments.fresh.map((comment) => commentEvent(snapshot, siteUrl, comment))
  ].sort((a, b) => DateTime.toEpochMillis(a.occurredAt) - DateTime.toEpochMillis(b.occurredAt))
  return {
    events,
    cursor: {
      v: 1,
      target: "issue",
      issueId: snapshot.id,
      changelog: changelog.position,
      comments: comments.position
    }
  }
}

/**
 * Issues entering and leaving a JQL result since the previous cursor, timed at `observedAt`.
 * Without a previous cursor, or when the query text changed, the poll is a baseline. Each edge
 * takes the next number of the cursor's edge counter, so replaying a poll gives the same keys.
 */
export const diffJql = (input: {
  readonly siteUrl: string
  readonly previous: JqlCursor | undefined
  readonly snapshot: JqlSnapshot
  readonly observedAt: DateTime.Utc
}): JqlPoll => {
  const { observedAt, previous, siteUrl, snapshot } = input
  const members = snapshot.issues.map((issue) => ({ id: issue.id, key: issue.key }))
  const baseline = previous === undefined || previous.jql !== snapshot.jql
  const edgesBefore = baseline ? 0 : previous.edges
  if (baseline) {
    return { events: [], cursor: { v: 1, target: "jql", jql: snapshot.jql, members, edges: edgesBefore } }
  }
  const before = new Set(previous.members.map((member) => member.id))
  const now = new Set(members.map((member) => member.id))
  let edges = edgesBefore
  const events: Array<JiraEvent> = []
  for (const issue of snapshot.issues) {
    if (before.has(issue.id)) continue
    edges += 1
    events.push({
      type: eventTypes.issueEntered,
      occurredAt: observedAt,
      summary: `${issue.key} entered the JQL result: ${clip(issue.summary, 120)}`,
      payload: { issue, jql: snapshot.jql },
      link: browseLink(siteUrl, issue.key),
      dedupeKey: `jql:${issue.id}:entered:${edges}`
    })
  }
  for (const member of previous.members) {
    if (now.has(member.id)) continue
    edges += 1
    events.push({
      type: eventTypes.issueLeft,
      occurredAt: observedAt,
      summary: `${member.key} left the JQL result`,
      payload: { issue: member, jql: snapshot.jql },
      link: browseLink(siteUrl, member.key),
      dedupeKey: `jql:${member.id}:left:${edges}`
    })
  }
  return { events, cursor: { v: 1, target: "jql", jql: snapshot.jql, members, edges } }
}
