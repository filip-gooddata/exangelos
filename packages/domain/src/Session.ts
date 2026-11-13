import { Schema } from "effect"

export const Harness = Schema.Literals(["t3", "claude-code", "codex"])
export type Harness = typeof Harness.Type

export const Session = Schema.Struct({
  harness: Harness,
  sessionId: Schema.NonEmptyString
})
export type Session = typeof Session.Type

const isBuiltIn = Schema.is(Harness)

/** The name of a harness you define in settings. It never takes a built-in harness's name. */
export const HarnessName = Schema.String.check(Schema.isPattern(/^(?!(?:t3|codex|claude-code)$)[a-z][a-z0-9-]{0,31}$/))
export type HarnessName = typeof HarnessName.Type

/**
 * A session id handed to a harness you define. It holds no shell syntax and cannot pass as an
 * option, since it lands in the command's arguments.
 */
export const HarnessSessionId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9._:@][A-Za-z0-9._:@-]{0,199}$/))

/** A session reached through a harness you define, by its name. */
export const NamedSession = Schema.Struct({
  harness: HarnessName,
  sessionId: HarnessSessionId
})
export type NamedSession = typeof NamedSession.Type

/**
 * Where a subscription's wakes go: a session of a built-in harness or of a harness you define.
 * Decoding does not consult settings, so a target whose harness you removed stays valid and its
 * wakes fail at delivery.
 */
export const Target = Schema.Union([Session, NamedSession])
export type Target = typeof Target.Type

export const isBuiltInTarget = (target: Target): target is Session => isBuiltIn(target.harness)

export const Actor = Schema.TaggedUnion({
  Session: { session: Session },
  You: {}
})
export type Actor = typeof Actor.Type

export const sameSession = (a: Target, b: Target): boolean =>
  a.harness === b.harness && a.sessionId === b.sessionId
