import type { Invocation, Outcome, Verdict } from "./Attempt.ts"
import { delivered, exitReason, failed, timedOutReason } from "./Attempt.ts"

/**
 * `t3 thread send -- <thread> -` with the wake text on stdin. A busy thread gets it as its next turn.
 *
 * t3's parser is the Effect CLI, whose lexer hands every word after `--` to the command as a
 * positional argument (effect 4.1.4 `cli/internal/lexer.ts` and `parser.ts`; the t3 binary carries
 * the same lexer). So a thread id that starts with a dash stays an id: t3 0.1.7 answers
 * `t3 thread send -- -nope -` with "Thread -nope was not found." (hand check, 2026-11-12).
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
      // Seen with t3 0.1.7 (hand check, 2026-11-12): an idle thread exits 0, prints "Sent." and
      // runs the text as its next turn. A busy thread exits 0, prints "Queued." and runs it after
      // the current turn. An unknown or deleted thread exits 1 with "Thread <id> was not found.",
      // an archived one exits 1 with "Thread <id> is archived and cannot receive messages." on
      // stderr. t3 logs its own warnings to stdout, so they never decide the verdict.
      return outcome.exitCode === 0 ? delivered() : failed(exitReason("t3", outcome))
  }
}
