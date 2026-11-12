import type { Invocation, Outcome, Refused, Verdict } from "./Attempt.ts"
import { delivered, exitReason, failed, timedOutReason } from "./Attempt.ts"

/**
 * `t3 thread send <thread> -` with the wake text on stdin. A busy thread gets it as its next turn.
 *
 * The thread id is a positional argument, and whether t3 honours `--` is not known, so an id that
 * starts with a dash is refused instead of being read as a flag. T3 thread ids are UUIDs or start
 * with `thread:`.
 */
export const invocation = (sessionId: string, text: string): Invocation | Refused =>
  sessionId.startsWith("-")
    ? { _tag: "Refused", reason: `t3 would read the thread id ${JSON.stringify(sessionId)} as a flag` }
    : { program: "t3", args: ["thread", "send", sessionId, "-"], stdin: text }

export const interpret = (outcome: Outcome): Verdict => {
  switch (outcome._tag) {
    case "NotStarted":
      return failed(`t3 could not start: ${outcome.reason}`)
    case "TimedOut":
      return failed(timedOutReason("t3", outcome))
    case "Exited":
      // Unverified: exit 0 means t3 accepted the text for a thread that exists, and a closed or
      // unknown thread exits non-zero. Hand check: send to an idle, a busy and an unknown thread.
      // Anything t3 prints on stderr with exit 0 is a warning, not a failure.
      return outcome.exitCode === 0 ? delivered() : failed(exitReason("t3", outcome))
  }
}
