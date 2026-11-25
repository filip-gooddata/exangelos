export interface Snapshot {
  readonly url: string
  readonly title: string
  readonly state: "OPEN" | "CLOSED" | "MERGED"
  readonly isDraft: boolean
  readonly mergedAt: string | null
  readonly closedAt: string | null
  readonly author: string
  readonly head: string
  readonly base: { readonly name: string; readonly oid: string }
  readonly mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN"
  readonly mergeStateStatus: string
  readonly reviewDecision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null
  readonly checks: ReadonlyArray<Check>
  readonly requiredChecks: ReadonlyArray<string>
  readonly reviews: ReadonlyArray<Review>
  readonly comments: ReadonlyArray<Comment>
  readonly threads: ReadonlyArray<Thread>
  readonly requestedReviewers: ReadonlyArray<string>
  readonly reviewRequests: ReadonlyArray<ReviewRequest>
  readonly draftEvents: ReadonlyArray<DraftEvent>
  /** When the watched reviewer first submitted a review here; null without a reviewer or a review. */
  readonly reviewerFirstReviewAt: string | null
}

export type CheckOutcome = "pending" | "passed" | "failed" | "cancelled"

export interface Check {
  readonly id: string
  readonly kind: "run" | "status"
  readonly name: string
  readonly outcome: CheckOutcome
  /** Concluded SUCCESS; `outcome` also counts NEUTRAL and SKIPPED as passed. */
  readonly succeeded: boolean
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
  readonly commit: string | null
}

export interface Comment {
  readonly id: string
  readonly author: string
  readonly body: string
  readonly createdAt: string
  readonly url: string
}

/** A review thread. `author`, `body`, `createdAt` and `url` belong to its opening comment. */
export interface Thread {
  readonly id: string
  readonly isResolved: boolean
  readonly path: string
  readonly openerId: string
  readonly author: string
  readonly body: string
  readonly createdAt: string
  readonly url: string
  readonly replies: ReadonlyArray<Comment>
}

/** A ReviewRequestedEvent from the timeline. `reviewer` is null when a team was asked. */
export interface ReviewRequest {
  readonly id: string
  readonly reviewer: string | null
  readonly createdAt: string
}

/** A ConvertToDraftEvent (`toDraft`) or ReadyForReviewEvent from the timeline. */
export interface DraftEvent {
  readonly id: string
  readonly toDraft: boolean
  readonly createdAt: string
}
