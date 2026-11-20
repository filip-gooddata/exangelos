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
import * as Executable from "./Executable.ts"
import * as T3 from "./T3.ts"

export interface Options {
  /** How long one attempt may run before it counts as failed. Default 30 seconds. */
  readonly limit?: Duration.Input
  /** Where the harness CLIs are looked up, read at each wake. Default the daemon's environment and file system. */
  readonly lookup?: () => Executable.Lookup
}

const defaultLimit = Duration.seconds(30)

const refuse = (reason: string, logged: string = reason): Effect.Effect<never, WakeTarget.DeliveryFailed> =>
  Effect.logWarning("wake refused", Cause.fail(new WakeTarget.DeliveryFailed({ reason: logged }))).pipe(
    Effect.annotateLogs("error", logged),
    Effect.andThen(Effect.fail(new WakeTarget.DeliveryFailed({ reason })))
  )

interface Runner {
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"]
  readonly lookup: () => Executable.Lookup
  readonly limit: Duration.Duration
}

const runner = (options: Options): Effect.Effect<Runner, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function*() {
    return {
      spawner: yield* ChildProcessSpawner.ChildProcessSpawner,
      lookup: options.lookup ?? Executable.system,
      limit: Duration.fromInputUnsafe(options.limit ?? defaultLimit)
    }
  })

const attempt = (
  { limit, lookup, spawner }: Runner,
  planned: Invocation,
  interpret: (outcome: Outcome) => Verdict,
  label: string
): Effect.Effect<void, WakeTarget.DeliveryFailed> =>
  Effect.gen(function*() {
    const located = Executable.locate(planned, lookup())
    const outcome = "_tag" in located ? located : yield* run(spawner, located, limit)
    const verdict = interpret(outcome)
    const annotations = { command: label, result: outcome._tag }
    if (verdict._tag === "Failed") {
      const error = quietReason(label, outcome)
      yield* Effect.logWarning("wake command failed", Cause.fail(new WakeTarget.DeliveryFailed({ reason: error }))).pipe(
        Effect.annotateLogs({ ...annotations, error })
      )
      return yield* new WakeTarget.DeliveryFailed({ reason: verdict.reason })
    }
    if (verdict.note !== undefined) yield* Effect.logWarning("wake delivered with a note").pipe(Effect.annotateLogs(annotations))
  })

const named = (
  runner: Runner,
  settings: SettingsStore.SettingsStore["Service"],
  target: Session.Target,
  content: Parameters<WakeTarget.WakeTarget["Service"]["deliver"]>[1]
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
      runner,
      Command.invocation(command, target, content.subscription, WakeText.render(content)),
      (outcome) => Command.interpret(command[0], outcome),
      "command"
    )
  })

export const layer = (
  options: Options = {}
): Layer.Layer<WakeTarget.WakeTarget, never, ChildProcessSpawner.ChildProcessSpawner | SettingsStore.SettingsStore> =>
  Layer.effect(WakeTarget.WakeTarget, Effect.gen(function*() {
    const run = yield* runner(options)
    const settings = yield* SettingsStore.SettingsStore
    return {
      deliver: (target, content) => {
        if (!Session.isBuiltInTarget(target)) return named(run, settings, target, content)
        const session = target
        switch (session.harness) {
          case "t3":
            return attempt(run, T3.invocation(session.sessionId, WakeText.render(content)), T3.interpret, "t3")
          case "codex":
            return attempt(run, Codex.invocation(session.sessionId, WakeText.render(content)), Codex.interpret, "codex")
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
    const run = yield* runner(options)
    return {
      deliver: (session, content) =>
        attempt(
          run,
          Command.invocation(command, session, content.subscription, WakeText.render(content)),
          (outcome) => Command.interpret(command[0], outcome),
          "command"
        )
    }
  }))
