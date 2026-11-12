import { Schema } from "effect"

export const Harness = Schema.Literals(["t3", "claude-code", "codex"])
export type Harness = typeof Harness.Type

export const Session = Schema.Struct({
  harness: Harness,
  sessionId: Schema.NonEmptyString
})
export type Session = typeof Session.Type

export const Actor = Schema.TaggedUnion({
  Session: { session: Session },
  You: {}
})
export type Actor = typeof Actor.Type

export const sameSession = (a: Session, b: Session): boolean =>
  a.harness === b.harness && a.sessionId === b.sessionId
