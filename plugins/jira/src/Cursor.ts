import { Effect, Schema } from "effect"
import { InvalidCursor } from "./JiraError.ts"
import type { IssuePosition } from "./Snapshot.ts"

const Position = Schema.Struct({
  consumed: Schema.Int,
  recent: Schema.Array(Schema.String),
  lastCreated: Schema.String
})

export const IssueCursor = Schema.Struct({
  v: Schema.Literal(1),
  target: Schema.Literal("issue"),
  issueId: Schema.String,
  changelog: Position,
  comments: Position
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
const JqlCursorJson = Schema.fromJsonString(JqlCursor)

export const encodeCursor = (cursor: IssueCursor | JqlCursor): string =>
  cursor.target === "issue"
    ? Schema.encodeSync(IssueCursorJson)(cursor)
    : Schema.encodeSync(JqlCursorJson)(cursor)

export const decodeIssueCursor = (cursor: string): Effect.Effect<IssueCursor, InvalidCursor> =>
  Schema.decodeEffect(IssueCursorJson)(cursor).pipe(
    Effect.mapError(() => new InvalidCursor({ reason: "The cursor is not an issue cursor of version 1." }))
  )

export const decodeJqlCursor = (cursor: string): Effect.Effect<JqlCursor, InvalidCursor> =>
  Schema.decodeEffect(JqlCursorJson)(cursor).pipe(
    Effect.mapError(() => new InvalidCursor({ reason: "The cursor is not a JQL cursor of version 1." }))
  )

/** Where the client resumes reading an issue; undefined means a baseline read. */
export const issuePosition = (cursor: IssueCursor | undefined): IssuePosition | undefined =>
  cursor === undefined ? undefined : { changelog: cursor.changelog, comments: cursor.comments }
