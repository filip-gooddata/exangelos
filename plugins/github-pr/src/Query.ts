const reviews = `reviews(last: 100, before: $reviews) {
  pageInfo { hasPreviousPage startCursor }
  nodes { id state body submittedAt url author { login } }
}`

const comments = `comments(last: 100, before: $comments) {
  pageInfo { hasPreviousPage startCursor }
  nodes { id body createdAt url author { login } }
}`

const threads = `reviewThreads(last: 100, before: $threads) {
  pageInfo { hasPreviousPage startCursor }
  nodes { id isResolved path comments(first: 1) { nodes { body createdAt url author { login } } } }
}`

const checks = `commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100, after: $checks) {
  pageInfo { hasNextPage endCursor }
  nodes {
    __typename
    ... on CheckRun { id name status conclusion completedAt detailsUrl isRequired(pullRequestNumber: $number) }
    ... on StatusContext { id context state createdAt targetUrl isRequired(pullRequestNumber: $number) }
  }
} } } } }`

/** One request carries the whole snapshot unless a connection overflows a page. */
export const pullRequest = `query PullRequest($owner: String!, $repo: String!, $number: Int!,
  $reviews: String, $comments: String, $threads: String, $checks: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      url title state isDraft mergedAt closedAt
      headRefOid baseRefName baseRefOid mergeable reviewDecision
      baseRef {
        refUpdateRule { requiredStatusCheckContexts }
        branchProtectionRule { requiredStatusCheckContexts }
      }
      ${reviews}
      ${comments}
      ${threads}
      ${checks}
    }
  }
}`

/** Fetches further pages of the connections that overflowed. */
export type Connection = "reviews" | "comments" | "threads" | "checks"

const selections: Record<Connection, string> = { reviews, comments, threads, checks }

/** Fetches the next page of each connection that overflowed. GraphQL refuses unused variables, so each is declared only when selected. */
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

export const viewer = `query Viewer { viewer { login } }`
