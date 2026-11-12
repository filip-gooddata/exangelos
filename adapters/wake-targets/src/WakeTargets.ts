import { Duration, Effect, Layer } from "effect"
import { ChildProcessSpawner } from "effect/process"
import { WakeTarget } from "@exangelos/application"
import { WakeText } from "@exangelos/contracts"
import type { Invocation, Outcome, Verdict } from "./Attempt.ts"
import { run } from "./Attempt.ts"
import * as ClaudeCode from "./ClaudeCode.ts"
import * as Codex from "./Codex.ts"
import * as Command from "./Command.ts"
import * as T3 from "./T3.ts"

export interface Options {
  /** How long one attempt may run before it counts as failed. Default 30 seconds. */
  readonly limit?: Duration.Input
}

const defaultLimit = Duration.seconds(30)

const attempt = (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  planned: Invocation,
  interpret: (outcome: Outcome) => Verdict,
  limit: Duration.Duration
): Effect.Effect<void, WakeTarget.DeliveryFailed> =>
  Effect.gen(function*() {
    const verdict = interpret(yield* run(spawner, planned, limit))
    if (verdict._tag === "Failed") return yield* new WakeTarget.DeliveryFailed({ reason: verdict.reason })
    if (verdict.note !== undefined) yield* Effect.logWarning(verdict.note)
  })

/**
 * Delivers each wake through the harness of its session: T3 Code or Codex. A Claude Code session
 * has no route and every wake for it fails at once (see `ClaudeCode`). One attempt per call; the
 * caller owns retries.
 */
export const layer = (options: Options = {}): Layer.Layer<WakeTarget.WakeTarget, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Layer.effect(WakeTarget.WakeTarget, Effect.gen(function*() {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const limit = Duration.fromInputUnsafe(options.limit ?? defaultLimit)
    return {
      deliver: (session, content) => {
        switch (session.harness) {
          case "t3":
            return attempt(spawner, T3.invocation(session.sessionId, WakeText.render(content)), T3.interpret, limit)
          case "codex":
            return attempt(spawner, Codex.invocation(session.sessionId, WakeText.render(content)), Codex.interpret, limit)
          case "claude-code":
            return Effect.fail(new WakeTarget.DeliveryFailed({ reason: ClaudeCode.noRoute(content.subscription) }))
        }
      }
    }
  }))

/** Delivers every wake through the owner's command instead of the harnesses. */
export const layerCommand = (
  command: Command.WakeCommand,
  options: Options = {}
): Layer.Layer<WakeTarget.WakeTarget, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Layer.effect(WakeTarget.WakeTarget, Effect.gen(function*() {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const limit = Duration.fromInputUnsafe(options.limit ?? defaultLimit)
    return {
      deliver: (session, content) =>
        attempt(
          spawner,
          Command.invocation(command, session, content.subscription, WakeText.render(content)),
          (outcome) => Command.interpret(command[0], outcome),
          limit
        )
    }
  }))
