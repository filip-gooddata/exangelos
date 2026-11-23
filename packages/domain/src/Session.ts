import { Schema } from "effect"

export const Harness = Schema.Literals(["t3", "claude-code", "codex"])
export type Harness = typeof Harness.Type

export const Session = Schema.Struct({
  harness: Harness,
  sessionId: Schema.NonEmptyString
})
export type Session = typeof Session.Type

const isBuiltIn = Schema.is(Harness)

export const HarnessName = Schema.String.check(Schema.isPattern(/^(?!(?:t3|codex|claude-code)$)[a-z][a-z0-9-]{0,31}$/))
export type HarnessName = typeof HarnessName.Type

export const HarnessSessionId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9._:@][A-Za-z0-9._:@-]{0,199}$/))

export const NamedSession = Schema.Struct({
  harness: HarnessName,
  sessionId: HarnessSessionId
})
export type NamedSession = typeof NamedSession.Type

export const Target = Schema.Union([Session, NamedSession])
export type Target = typeof Target.Type

/** A session's human title as its harness names it, such as a T3 Code thread's title. */
export const SessionTitle = Schema.Struct({
  harness: Schema.Union([Harness, HarnessName]),
  sessionId: Schema.NonEmptyString,
  title: Schema.NonEmptyString
})
export type SessionTitle = typeof SessionTitle.Type

export const isBuiltInTarget = (target: Target): target is Session => isBuiltIn(target.harness)

export const Actor = Schema.TaggedUnion({
  Session: { session: Session },
  You: {}
})
export type Actor = typeof Actor.Type

export const sameSession = (a: Target, b: Target): boolean =>
  a.harness === b.harness && a.sessionId === b.sessionId
