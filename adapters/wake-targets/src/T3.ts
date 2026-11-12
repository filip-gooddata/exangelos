import type { Invocation, Outcome, Verdict } from "./Attempt.ts"
import { delivered, exitReason, failed, timedOutReason } from "./Attempt.ts"

/**
 * `t3 thread send -- <thread> -` with the wake text on stdin. A busy thread gets it as its next turn.
 *
 * t3's parser is the Effect CLI, whose lexer hands every word after `--` to the command as a
 * positional argument (effect 4.1.4 `cli/internal/lexer.ts` and `parser.ts`; the t3 binary carries
 * the same lexer). So a thread id that starts with a dash stays an id. Unverified against t3 itself.
 * Hand check: `t3 thread send -- <thread> -` into a real idle thread.
 */
export const invocation = (sessionId: string, text: string): Invocation => ({
  program: "t3",
  args: ["thread", "send", "--", sessionId, "-"],
  stdin: text
})

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
