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

/**
 * How far an oldest-first list was read: the items consumed so far, the ids of the last
 * `overlap` of them in order, and when the last one was created (ISO, "" before any).
 */
export interface ListPosition {
  readonly consumed: number
  readonly recent: ReadonlyArray<string>
  readonly lastCreated: string
  /** Every id consumed with the `lastCreated` time, so ties survive deletions. */
  readonly atLast: ReadonlyArray<string>
}

export interface IssuePosition {
  readonly changelog: ListPosition
  readonly comments: ListPosition
}

/** How many items before a position a poll re-reads, and how many ids a position remembers. */
export const overlap = 50
