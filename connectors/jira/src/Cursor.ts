import { Effect, Schema } from "effect"
import { InvalidCursor } from "./JiraError.ts"
import type { IssuePosition } from "./Snapshot.ts"

const Position = Schema.Struct({
  consumed: Schema.Int,
  recent: Schema.Array(Schema.String),
  lastCreated: Schema.String,
  atLast: Schema.Array(Schema.String)
})

export const GitHubCursor = Schema.Struct({
  repo: Schema.String,
  search: Schema.String,
  since: Schema.String,
  pullRequests: Schema.Array(Schema.Struct({ number: Schema.Finite, state: Schema.String })),
  paths: Schema.Array(Schema.Struct({ path: Schema.String, seen: Schema.Array(Schema.String) })),
  release: Schema.NullOr(Schema.Struct({ sha: Schema.String, tag: Schema.NullOr(Schema.String) }))
})
export type GitHubCursor = typeof GitHubCursor.Type

const IssueCursorV1 = Schema.Struct({
  v: Schema.Literal(1),
  target: Schema.Literal("issue"),
  issueId: Schema.String,
  changelog: Position,
  comments: Position
})

export const IssueCursor = Schema.Struct({
  v: Schema.Literal(2),
  target: Schema.Literal("issue"),
  issueId: Schema.String,
  changelog: Position,
  comments: Position,
  github: Schema.NullOr(GitHubCursor),
  githubFailure: Schema.NullOr(Schema.Struct({ scope: Schema.String, reason: Schema.String })),
  githubFailures: Schema.Int,
  values: Schema.optionalKey(Schema.Record(Schema.String, Schema.NullOr(Schema.String))),
  valueChanges: Schema.optionalKey(Schema.Int)
})
export type IssueCursor = typeof IssueCursor.Type

export const JqlCursor = Schema.Struct({
  v: Schema.Literal(1),
  target: Schema.Literal("jql"),
  jql: Schema.String,
  members: Schema.Array(Schema.Struct({ id: Schema.String, key: Schema.String })),
  edges: Schema.Int
})
export type JqlCursor = typeof JqlCursor.Type

const IssueCursorJson = Schema.fromJsonString(IssueCursor)
const AnyIssueCursorJson = Schema.fromJsonString(Schema.Union([IssueCursor, IssueCursorV1]))
const JqlCursorJson = Schema.fromJsonString(JqlCursor)

export const encodeCursor = (cursor: IssueCursor | JqlCursor): string =>
  cursor.target === "issue"
    ? Schema.encodeSync(IssueCursorJson)(cursor)
    : Schema.encodeSync(JqlCursorJson)(cursor)

export const decodeIssueCursor = (cursor: string): Effect.Effect<IssueCursor, InvalidCursor> =>
  Schema.decodeEffect(AnyIssueCursorJson)(cursor).pipe(
    Effect.map((decoded): IssueCursor => decoded.v === 2 ? decoded : { ...decoded, v: 2, github: null, githubFailure: null, githubFailures: 0 }),
    Effect.mapError(() => new InvalidCursor({ reason: "The cursor is not an issue cursor of version 1 or 2." }))
  )

export const decodeJqlCursor = (cursor: string): Effect.Effect<JqlCursor, InvalidCursor> =>
  Schema.decodeEffect(JqlCursorJson)(cursor).pipe(
    Effect.mapError(() => new InvalidCursor({ reason: "The cursor is not a JQL cursor of version 1." }))
  )

/** Where the client resumes reading an issue; undefined means a baseline read. */
export const issuePosition = (cursor: IssueCursor | undefined): IssuePosition | undefined =>
  cursor === undefined ? undefined : { changelog: cursor.changelog, comments: cursor.comments }
