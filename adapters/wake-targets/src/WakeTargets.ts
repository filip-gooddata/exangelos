import { Duration, Effect, Layer, Record } from "effect"
import { ChildProcessSpawner } from "effect/process"
import { SettingsStore, WakeTarget } from "@exangelos/application"
import { CommandHarness, Session } from "@exangelos/domain"
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
 * Runs the command of a harness you define, read from the settings at delivery time, with the
 * session and subscription put into its arguments. A harness you removed fails the wake.
 */
const named = (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  settings: SettingsStore.SettingsStore["Service"],
  target: Session.Target,
  content: Parameters<WakeTarget.WakeTarget["Service"]["deliver"]>[1],
  limit: Duration.Duration
): Effect.Effect<void, WakeTarget.DeliveryFailed> =>
  Effect.gen(function*() {
    const current = yield* settings.read.pipe(
      Effect.mapError((error) => new WakeTarget.DeliveryFailed({ reason: `the settings could not be read: ${error.reason}` }))
    )
    if (!Record.has(current.harnesses, target.harness)) {
      return yield* new WakeTarget.DeliveryFailed({ reason: `no harness named "${target.harness}" in the settings` })
    }
    const command = CommandHarness.substitute(current.harnesses[target.harness]!.command, {
      session: target.sessionId,
      subscription: content.subscription
    })
    return yield* attempt(
      spawner,
      Command.invocation(command, target, content.subscription, WakeText.render(content)),
      (outcome) => Command.interpret(command[0], outcome),
      limit
    )
  })

/**
 * Delivers each wake through the harness of its session: T3 Code, Codex, or a harness you define in
 * the settings. A Claude Code session has no route and every wake for it fails at once (see
 * `ClaudeCode`). One attempt per call; the caller owns retries.
 */
export const layer = (
  options: Options = {}
): Layer.Layer<WakeTarget.WakeTarget, never, ChildProcessSpawner.ChildProcessSpawner | SettingsStore.SettingsStore> =>
  Layer.effect(WakeTarget.WakeTarget, Effect.gen(function*() {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const settings = yield* SettingsStore.SettingsStore
    const limit = Duration.fromInputUnsafe(options.limit ?? defaultLimit)
    return {
      deliver: (target, content) => {
        if (!Session.isBuiltInTarget(target)) return named(spawner, settings, target, content, limit)
        const session = target
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
