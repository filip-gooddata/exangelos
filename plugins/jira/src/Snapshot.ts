import type { DateTime } from "effect"

/** What one poll of a target returns. The client builds these; the diff functions read them. */

export interface Person {
  readonly accountId: string | undefined
  readonly displayName: string | undefined
}

/** One item of a changelog history: one field that changed. */
export interface FieldChange {
  readonly field: string
  readonly fieldId: string | undefined
  readonly from: string | null
  readonly fromString: string | null
  readonly to: string | null
  readonly toString: string | null
}

export interface History {
  readonly id: string
  readonly created: DateTime.Utc
  readonly author: Person | undefined
  readonly items: ReadonlyArray<FieldChange>
}

export interface Comment {
  readonly id: string
  readonly created: DateTime.Utc
  readonly author: Person | undefined
  /** Atlassian Document Format, as Jira returns it. */
  readonly body: unknown
}

/**
 * A tail of an oldest-first list: every item from offset `start` to the end Jira reported.
 * The client re-reads an overlap before the cursor's position, so items the cursor already
 * covers can appear; the diff drops them by id.
 */
export interface ListTail<A> {
  readonly start: number
  readonly items: ReadonlyArray<A>
}

export interface IssueSnapshot {
  readonly id: string
  readonly key: string
  readonly summary: string
  readonly changelog: ListTail<History>
  readonly comments: ListTail<Comment>
}

export interface JqlIssue {
  readonly id: string
  readonly key: string
  readonly summary: string
}

/** The full current result of a JQL query, in Jira's order. */
export interface JqlSnapshot {
  readonly jql: string
  readonly issues: ReadonlyArray<JqlIssue>
}

/** How far a list was read: items consumed so far and the highest id seen ("" before any). */
export interface ListPosition {
  readonly consumed: number
  readonly lastId: string
}

export interface IssuePosition {
  readonly changelog: ListPosition
  readonly comments: ListPosition
}
