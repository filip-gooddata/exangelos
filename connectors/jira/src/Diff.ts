import { DateTime } from "effect"
import type { IssueCursor, JqlCursor } from "./Cursor.ts"
import { reportsField } from "./Options.ts"
import { overlap } from "./Snapshot.ts"
import { browseLink } from "./Site.ts"
import type { Comment, FieldChange, History, IssueSnapshot, JqlSnapshot, ListPosition, ListTail, Person } from "./Snapshot.ts"

export const eventTypes = {
  statusChanged: "status.changed",
  commentAdded: "comment.added",
  commentDeleted: "comment.deleted",
  assigneeChanged: "assignee.changed",
  fieldChanged: "field.changed",
  issueEntered: "issue.entered",
  issueLeft: "issue.left",
  pullRequestFound: "pull_request.found",
  pullRequestStateChanged: "pull_request.state_changed",
  commitAdded: "commit.added",
  releaseFound: "release.found",
  githubUnavailable: "github.unavailable"
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

/**
 * Splits a tail into the items the previous position had not seen and the position after it.
 * New items are those after the last item whose id the position remembers. When none of those
 * ids is left (all deleted), new items are those created after the remembered time, or at it
 * with an id the position does not hold among the ids seen at that time.
 */
const advance = <A extends { readonly id: string; readonly created: DateTime.Utc }>(
  previous: ListPosition | undefined,
  tail: ListTail<A>
): { readonly fresh: ReadonlyArray<A>; readonly position: ListPosition } => {
  const last = tail.items.at(-1)
  const lastCreated = last === undefined ? previous?.lastCreated ?? "" : DateTime.formatIso(last.created)
  const atLastTime = last === undefined
    ? []
    : tail.items.filter((item) => DateTime.Equivalence(item.created, last.created)).map((item) => item.id)
  const carried = previous !== undefined && previous.lastCreated === lastCreated ? previous.atLast : []
  const position: ListPosition = {
    consumed: tail.start + tail.items.length,
    recent: tail.items.slice(-overlap).map((item) => item.id),
    lastCreated,
    atLast: [...new Set([...carried, ...atLastTime])]
  }
  if (previous === undefined) return { fresh: [], position }
  const seen = new Set(previous.recent)
  const anchor = tail.items.findLastIndex((item) => seen.has(item.id))
  if (anchor >= 0) return { fresh: tail.items.slice(anchor + 1), position }
  if (previous.lastCreated === "") return { fresh: tail.items, position }
  const after = DateTime.toEpochMillis(DateTime.makeUnsafe(previous.lastCreated))
  const seenAtLast = new Set(previous.atLast)
  const fresh = tail.items.filter((item) => {
    const created = DateTime.toEpochMillis(item.created)
    return created > after || (created === after && !seenAtLast.has(item.id))
  })
  return { fresh, position }
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

const historyEvents = (
  snapshot: IssueSnapshot,
  link: string,
  history: History,
  fields: ReadonlyArray<string> | undefined
): ReadonlyArray<JiraEvent> =>
  history.items.flatMap((change, index) => {
    const type = typeOfChange(change)
    if (type === eventTypes.fieldChanged && !reportsField(fields, { field: change.field, fieldId: change.fieldId ?? null })) {
      return []
    }
    const what = type === eventTypes.fieldChanged ? change.field : type === eventTypes.statusChanged ? "status" : "assignee"
    return [{
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
    }]
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
 * A cursor for another issue id also counts as none. Items the cursor already covers are
 * dropped, so replaying a poll emits nothing twice.
 */
export const diffIssue = (input: {
  readonly siteUrl: string
  readonly previous: IssueCursor | undefined
  readonly snapshot: IssueSnapshot
  readonly fields?: ReadonlyArray<string> | undefined
  readonly observedAt: DateTime.Utc
}): IssuePoll => {
  const { fields, observedAt, previous, siteUrl, snapshot } = input
  const link = browseLink(siteUrl, snapshot.key)
  const known = previous?.issueId === snapshot.id ? previous : undefined
  const changelog = advance(known?.changelog, snapshot.changelog)
  const comments = advance(known?.comments, snapshot.comments)
  const events = [
    ...changelog.fresh.flatMap((history) => historyEvents(snapshot, link, history, fields)),
    ...comments.fresh.map((comment) => commentEvent(snapshot, siteUrl, comment))
  ].sort((a, b) => DateTime.toEpochMillis(a.occurredAt) - DateTime.toEpochMillis(b.occurredAt))
  if (known !== undefined) {
    const before = known.comments.consumed
    const after = comments.position.consumed
    const removed = before + comments.fresh.length - after
    if (removed > 0) {
      events.push({
        type: eventTypes.commentDeleted,
        occurredAt: observedAt,
        summary: `${snapshot.key}: ${removed === 1 ? "a comment was" : `${removed} comments were`} deleted (${after} left)`,
        payload: { issue: { id: snapshot.id, key: snapshot.key, summary: snapshot.summary }, removed, count: after },
        link,
        dedupeKey: `${snapshot.id}:comments-deleted:${known.comments.recent.at(-1) ?? ""}:${before}:${after}`
      })
    }
  }
  return {
    events,
    cursor: {
      v: 2,
      target: "issue",
      issueId: snapshot.id,
      changelog: changelog.position,
      comments: comments.position,
      github: known?.github ?? null,
      githubFailure: known?.githubFailure ?? null,
      githubFailures: known?.githubFailures ?? 0
    }
  }
}

/**
 * Issues entering and leaving a JQL result since the previous cursor, timed at `observedAt`.
 * Without a previous cursor, or when the query text changed, the poll is a baseline that keeps
 * the edge counter. Each edge
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
  if (baseline) {
    return { events: [], cursor: { v: 1, target: "jql", jql: snapshot.jql, members, edges: previous?.edges ?? 0 } }
  }
  const before = new Set(previous.members.map((member) => member.id))
  const now = new Set(members.map((member) => member.id))
  let edges = previous.edges
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
