/** What one poll knows about a pull request. */
export interface Snapshot {
  readonly url: string
  readonly title: string
  readonly state: "OPEN" | "CLOSED" | "MERGED"
  readonly isDraft: boolean
  readonly mergedAt: string | null
  readonly closedAt: string | null
  readonly head: string
  readonly base: { readonly name: string; readonly oid: string }
  readonly mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN"
  readonly reviewDecision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null
  readonly checks: ReadonlyArray<Check>
  /** Check names the base branch requires, whether or not they have posted. */
  readonly requiredChecks: ReadonlyArray<string>
  /** The newest reviews, comments and threads, oldest first, reaching back at least to what the last poll saw. */
  readonly reviews: ReadonlyArray<Review>
  readonly comments: ReadonlyArray<Comment>
  readonly threads: ReadonlyArray<Thread>
}

export type CheckOutcome = "pending" | "passed" | "failed" | "cancelled"

export interface Check {
  readonly id: string
  /** A check run or a commit status. */
  readonly kind: "run" | "status"
  readonly name: string
  readonly outcome: CheckOutcome
  readonly required: boolean
  readonly url: string | null
  readonly completedAt: string | null
}

export interface Review {
  readonly id: string
  readonly author: string
  readonly state: string
  readonly body: string
  readonly submittedAt: string
  readonly url: string
}

export interface Comment {
  readonly id: string
  readonly author: string
  readonly body: string
  readonly createdAt: string
  readonly url: string
}

/** A review thread, dated and attributed by its first comment. */
export interface Thread {
  readonly id: string
  readonly isResolved: boolean
  readonly path: string
  readonly author: string
  readonly body: string
  readonly createdAt: string
  readonly url: string
}
