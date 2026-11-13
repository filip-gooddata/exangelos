import { Schema } from "effect"
import { Catalogue } from "@exangelos/plugin-sdk"
import type { Plugin } from "@exangelos/plugin-sdk"
import { eventTypes } from "./Diff.ts"
import type { JiraEvent, JiraEventType } from "./Diff.ts"

const Issue = Schema.Struct({ id: Schema.String, key: Schema.String, summary: Schema.String })

const Person = Schema.Struct({
  accountId: Schema.optional(Schema.String),
  displayName: Schema.optional(Schema.String)
})

const Change = Schema.Struct({
  issue: Issue,
  historyId: Schema.String,
  author: Schema.NullOr(Person),
  field: Schema.String,
  fieldId: Schema.NullOr(Schema.String),
  from: Schema.NullOr(Schema.String),
  fromString: Schema.NullOr(Schema.String),
  to: Schema.NullOr(Schema.String),
  toString: Schema.NullOr(Schema.String)
})

const missedBetweenPolls =
  "An issue that enters and leaves the result between two polls is never seen. Emitted only by JQL subscriptions."

export const statusChanged = Catalogue.event(eventTypes.statusChanged, {
  description: "The issue moved to another status.",
  payload: Change
})

export const commentAdded = Catalogue.event(eventTypes.commentAdded, {
  description: "Someone commented on the issue. The body is Atlassian Document Format.",
  payload: Schema.Struct({
    issue: Issue,
    commentId: Schema.String,
    author: Schema.NullOr(Person),
    body: Schema.Unknown
  })
})

export const assigneeChanged = Catalogue.event(eventTypes.assigneeChanged, {
  description: "The issue was assigned to someone else, or unassigned.",
  payload: Change
})

export const fieldChanged = Catalogue.event(eventTypes.fieldChanged, {
  description: "A field other than status or assignee changed.",
  payload: Change
})

export const issueEntered = Catalogue.event(eventTypes.issueEntered, {
  description: `An issue started matching the JQL query. ${missedBetweenPolls}`,
  payload: Schema.Struct({ issue: Issue, jql: Schema.String })
})

export const issueLeft = Catalogue.event(eventTypes.issueLeft, {
  description: `An issue stopped matching the JQL query. ${missedBetweenPolls}`,
  payload: Schema.Struct({ issue: Schema.Struct({ id: Schema.String, key: Schema.String }), jql: Schema.String })
})

export const all = [statusChanged, commentAdded, assigneeChanged, fieldChanged, issueEntered, issueLeft] as const

export type WatchItem = ReturnType<typeof Plugin.end>

const byType: Record<JiraEventType, Catalogue.EventType<any>> = {
  [eventTypes.statusChanged]: statusChanged,
  [eventTypes.commentAdded]: commentAdded,
  [eventTypes.assigneeChanged]: assigneeChanged,
  [eventTypes.fieldChanged]: fieldChanged,
  [eventTypes.issueEntered]: issueEntered,
  [eventTypes.issueLeft]: issueLeft
}

/** The watch item for a diffed event; its payload is checked against the catalogue as it is encoded. */
export const toItem = (event: JiraEvent): WatchItem =>
  byType[event.type].item({
    occurredAt: event.occurredAt,
    summary: event.summary,
    payload: event.payload,
    dedupeKey: event.dedupeKey,
    link: event.link
  })
