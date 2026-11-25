import { Effect, Schema } from "effect"

/** What one subscription watches: a single issue, or the set of issues a JQL query matches. */
export type Target =
  | { readonly kind: "issue"; readonly key: string }
  | { readonly kind: "jql"; readonly jql: string }

export const TargetKind = Schema.Literals(["issue", "jql"])

/**
 * The subscription parameters. `target` holds an issue key or a JQL query. Without `kind`, a
 * target shaped like an issue key (PROJECT-123) is an issue and anything else is a query.
 */
export const Parameters = Schema.Struct({
  target: Schema.String,
  kind: Schema.optionalKey(TargetKind),
  fields: List("Field ids or names whose changes field.changed reports; default all"),
  githubRepo: Schema.optionalKey(
    Schema.String.annotate({ description: "owner/repo: report pull requests that mention the issue, and the signals below" })
  ),
  githubSearch: Schema.optionalKey(
    Schema.String.annotate({ description: "Search text for the pull requests; default the issue key" })
  ),
  githubPaths: List("Paths in githubRepo whose new commits commit.added reports"),
  since: Schema.optionalKey(
    Schema.String.annotate({ description: "ISO time; commits to githubPaths are read from it on; default the first poll" })
  ),
  sha: Schema.optionalKey(
    Schema.String.annotate({ description: "A commit SHA; release.found reports the newest release that contains it" })
  )
})
export type Parameters = typeof Parameters.Type

/** A list, or from the command line one value or a JSON array in a string. */
function List(description: string) {
  return Schema.optionalKey(Schema.Union([Schema.Array(Schema.String), Schema.String]).annotate({ description }))
}

const issueKey = /^[A-Z][A-Z0-9_]*-[1-9][0-9]*$/

export class TargetInvalid extends Schema.TaggedError<TargetInvalid>()("TargetInvalid", {
  reason: Schema.String
}) {}

export const parseTarget = (parameters: Parameters): Effect.Effect<Target, TargetInvalid> => {
  const text = parameters.target.trim()
  if (text === "") return Effect.fail(new TargetInvalid({ reason: "The target is empty: give an issue key or a JQL query." }))
  const key = text.toUpperCase()
  const looksLikeKey = issueKey.test(key)
  const kind = parameters.kind ?? (looksLikeKey ? "issue" : "jql")
  if (kind === "jql") return Effect.succeed({ kind, jql: text })
  return looksLikeKey
    ? Effect.succeed({ kind, key })
    : Effect.fail(new TargetInvalid({ reason: `"${text}" is not an issue key such as PROJECT-123.` }))
}

/** The parameters Describe hands back: the target as watched, with its kind spelled out. */
export const normalise = (target: Target): Parameters =>
  target.kind === "issue" ? { target: target.key, kind: "issue" } : { target: target.jql, kind: "jql" }

export const subject = (target: Target): string =>
  target.kind === "issue" ? `issue:${target.key}` : `jql:${target.jql}`

export const label = (target: Target): string => {
  if (target.kind === "issue") return target.key
  return target.jql.length <= 60 ? `JQL: ${target.jql}` : `JQL: ${target.jql.slice(0, 59)}…`
}
