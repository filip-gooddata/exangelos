import { Schema } from "effect"
import { Catalogue } from "@exangelos/connector-sdk"
import type { Connector } from "@exangelos/connector-sdk"
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
  description: "A field other than status or assignee changed. With fields, only the fields it names.",
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

const PullRequest = {
  issue: Issue,
  repo: Schema.String,
  number: Schema.Finite,
  title: Schema.String,
  state: Schema.Literals(["open", "closed", "merged"]),
  url: Schema.String,
  author: Schema.NullOr(Schema.String)
}

const fromGitHub = "Emitted only with githubRepo. Polled with the issue, once a minute."

export const pullRequestFound = Catalogue.event(eventTypes.pullRequestFound, {
  description: `A pull request in githubRepo started matching githubSearch (default the issue key). ${fromGitHub}`,
  payload: Schema.Struct(PullRequest)
})

export const pullRequestStateChanged = Catalogue.event(eventTypes.pullRequestStateChanged, {
  description: `A matching pull request was closed, merged or reopened. ${fromGitHub}`,
  payload: Schema.Struct({ ...PullRequest, from: Schema.String })
})

export const commitAdded = Catalogue.event(eventTypes.commitAdded, {
  description: `A new commit in githubRepo touched githubPaths; paths lists the ones it touched. ${fromGitHub}`,
  payload: Schema.Struct({
    issue: Issue,
    repo: Schema.String,
    paths: Schema.Array(Schema.String),
    sha: Schema.String,
    message: Schema.String,
    url: Schema.String,
    author: Schema.NullOr(Schema.String)
  })
})

export const releaseFound = Catalogue.event(eventTypes.releaseFound, {
  description: `One of the newest five releases of githubRepo contains sha. Reported once, on the first poll too. ${fromGitHub}`,
  payload: Schema.Struct({ issue: Issue, repo: Schema.String, sha: Schema.String, tag: Schema.String, url: Schema.String })
})

export const githubUnavailable = Catalogue.event(eventTypes.githubUnavailable, {
  description:
    "GitHub refused githubToken, githubRepo or sha is gone, or no githubToken is configured. Jira events continue; the GitHub signals are retried every poll and this fires again only after they recover and fail anew.",
  payload: Schema.Struct({ issue: Issue, repo: Schema.String, reason: Schema.String })
})

export const all = [
  statusChanged,
  commentAdded,
  assigneeChanged,
  fieldChanged,
  issueEntered,
  issueLeft,
  pullRequestFound,
  pullRequestStateChanged,
  commitAdded,
  releaseFound,
  githubUnavailable
] as const

export type WatchItem = ReturnType<typeof Connector.end>

const byType: Record<JiraEventType, Catalogue.EventType<any>> = {
  [eventTypes.statusChanged]: statusChanged,
  [eventTypes.commentAdded]: commentAdded,
  [eventTypes.assigneeChanged]: assigneeChanged,
  [eventTypes.fieldChanged]: fieldChanged,
  [eventTypes.issueEntered]: issueEntered,
  [eventTypes.issueLeft]: issueLeft,
  [eventTypes.pullRequestFound]: pullRequestFound,
  [eventTypes.pullRequestStateChanged]: pullRequestStateChanged,
  [eventTypes.commitAdded]: commitAdded,
  [eventTypes.releaseFound]: releaseFound,
  [eventTypes.githubUnavailable]: githubUnavailable
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
