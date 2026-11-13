import type { Session } from "@exangelos/domain"
import type { Invocation, Outcome, Verdict } from "./Attempt.ts"
import { delivered, exitReason, failed, timedOutReason } from "./Attempt.ts"

/**
 * The owner's command, as a program and its arguments, run without a shell. It gets the wake text
 * on stdin and the session in `EXANGELOS_HARNESS` and `EXANGELOS_SESSION_ID`, the subscription in
 * `EXANGELOS_SUBSCRIPTION`, on top of the daemon's environment.
 *
 * The command should exit once it has handed the text on, within the limit. A run past the limit
 * may already have delivered, and the daemon retries every failed attempt, so the command has to
 * tolerate getting the same wake twice.
 */
export type WakeCommand = readonly [program: string, ...args: Array<string>]

export const invocation = (
  command: WakeCommand,
  session: Session.Target,
  subscription: string,
  text: string
): Invocation => ({
  program: command[0],
  args: command.slice(1),
  stdin: text,
  env: {
    EXANGELOS_HARNESS: session.harness,
    EXANGELOS_SESSION_ID: session.sessionId,
    EXANGELOS_SUBSCRIPTION: subscription
  }
})

/** Exit 0 is delivered. Anything else, a run past the limit or a command that cannot start, failed. */
export const interpret = (program: string, outcome: Outcome): Verdict => {
  switch (outcome._tag) {
    case "NotStarted":
      return failed(`${program} could not start: ${outcome.reason}`)
    case "TimedOut":
      return failed(timedOutReason(program, outcome))
    case "Exited":
      return outcome.exitCode === 0 ? delivered() : failed(exitReason(program, outcome))
  }
}
