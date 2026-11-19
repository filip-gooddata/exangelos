import { Cause, Duration, Effect, Layer, Record } from "effect"
import { ChildProcessSpawner } from "effect/process"
import { SettingsStore, WakeTarget } from "@exangelos/application"
import { CommandHarness, Session } from "@exangelos/domain"
import { WakeText } from "@exangelos/contracts"
import type { Invocation, Outcome, Verdict } from "./Attempt.ts"
import { quietReason, run } from "./Attempt.ts"
import * as ClaudeCode from "./ClaudeCode.ts"
import * as Codex from "./Codex.ts"
import * as Command from "./Command.ts"
import * as T3 from "./T3.ts"

export interface Options {
  /** How long one attempt may run before it counts as failed. Default 30 seconds. */
  readonly limit?: Duration.Input
}

const defaultLimit = Duration.seconds(30)

const refuse = (reason: string, logged: string = reason): Effect.Effect<never, WakeTarget.DeliveryFailed> =>
  Effect.logWarning("wake refused", Cause.fail(new WakeTarget.DeliveryFailed({ reason: logged }))).pipe(
    Effect.annotateLogs("error", logged),
    Effect.andThen(Effect.fail(new WakeTarget.DeliveryFailed({ reason })))
  )

const attempt = (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  planned: Invocation,
  interpret: (outcome: Outcome) => Verdict,
  limit: Duration.Duration
): Effect.Effect<void, WakeTarget.DeliveryFailed> =>
  Effect.gen(function*() {
    const outcome = yield* run(spawner, planned, limit)
    const verdict = interpret(outcome)
    const annotations = { program: planned.program, result: outcome._tag }
    if (verdict._tag === "Failed") {
      const error = quietReason(planned.program, outcome)
      yield* Effect.logWarning("wake command failed", Cause.fail(new WakeTarget.DeliveryFailed({ reason: error }))).pipe(
        Effect.annotateLogs({ ...annotations, error })
      )
      return yield* new WakeTarget.DeliveryFailed({ reason: verdict.reason })
    }
    if (verdict.note !== undefined) yield* Effect.logWarning("wake delivered with a note").pipe(Effect.annotateLogs(annotations))
  })

const named = (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  settings: SettingsStore.SettingsStore["Service"],
  target: Session.Target,
  content: Parameters<WakeTarget.WakeTarget["Service"]["deliver"]>[1],
  limit: Duration.Duration
): Effect.Effect<void, WakeTarget.DeliveryFailed> =>
  Effect.gen(function*() {
    const current = yield* settings.read.pipe(
      Effect.catch((error) =>
        refuse(`the settings could not be read: ${error.reason}`, "the settings could not be read"))
    )
    if (!Record.has(current.harnesses, target.harness)) {
      return yield* refuse(`no harness named "${target.harness}" in the settings`)
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
            return refuse(ClaudeCode.noRoute(content.subscription))
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
