const reviews = `reviews(last: 100, before: $reviews) {
  pageInfo { hasPreviousPage startCursor }
  nodes { id state body submittedAt url author { login } commit { oid } }
}`

const comments = `comments(last: 100, before: $comments) {
  pageInfo { hasPreviousPage startCursor }
  nodes { id body createdAt url author { login } }
}`

const threadComment = `id body createdAt publishedAt state url author { login }`

const threads = `reviewThreads(last: 100, before: $threads) {
  pageInfo { hasPreviousPage startCursor }
  nodes {
    id isResolved path
    opener: comments(first: 1) { nodes { ${threadComment} } }
    replies: comments(last: 50) { pageInfo { hasPreviousPage startCursor } nodes { ${threadComment} } }
  }
}`

const requests = `timelineItems(last: 50, before: $requests, itemTypes: [REVIEW_REQUESTED_EVENT]) {
  pageInfo { hasPreviousPage startCursor }
  nodes { ... on ReviewRequestedEvent { id createdAt requestedReviewer { __typename ... on User { login } } } }
}`

const checks = `commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100, after: $checks) {
  pageInfo { hasNextPage endCursor }
  nodes {
    __typename
    ... on CheckRun { id name status conclusion completedAt detailsUrl isRequired(pullRequestNumber: $number) }
    ... on StatusContext { id context state createdAt targetUrl isRequired(pullRequestNumber: $number) }
  }
} } } } }`

export const pullRequest = `query PullRequest($owner: String!, $repo: String!, $number: Int!,
  $reviews: String, $comments: String, $threads: String, $requests: String, $checks: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      url title state isDraft mergedAt closedAt author { login }
      headRefOid baseRefName baseRefOid mergeable mergeStateStatus reviewDecision
      baseRef {
        refUpdateRule { requiredStatusCheckContexts }
        branchProtectionRule { requiredStatusCheckContexts }
      }
      reviewRequests(first: 100) { nodes { requestedReviewer { __typename ... on User { login } } } }
      ${reviews}
      ${comments}
      ${threads}
      ${requests}
      ${checks}
    }
  }
}`

export type Connection = "reviews" | "comments" | "threads" | "requests" | "checks"

const selections: Record<Connection, string> = { reviews, comments, threads, requests, checks }

export const morePages = (connections: ReadonlyArray<Connection>) =>
  `query PullRequestPages($owner: String!, $repo: String!, $number: Int!${
    connections.map((c) => `, $${c}: String`).join("")
  }) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      ${connections.map((c) => selections[c]).join("\n")}
    }
  }
}`

/** Older comments of one review thread, for a thread with more replies than the first query returns. */
export const threadReplies = `query ThreadReplies($id: ID!, $before: String) {
  node(id: $id) {
    ... on PullRequestReviewThread {
      comments(last: 100, before: $before) {
        pageInfo { hasPreviousPage startCursor }
        nodes { ${threadComment} }
      }
    }
  }
}`

export const viewer = `query Viewer { viewer { login } }`
