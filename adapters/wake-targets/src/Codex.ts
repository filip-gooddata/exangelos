import type { Invocation, Outcome, Verdict } from "./Attempt.ts"
import { delivered, exitReason, failed, lastLine, timedOutReason } from "./Attempt.ts"

/**
 * `codex queue --thread=<id> --message=<text> --resume`. codex queue takes no text on stdin, so the
 * text is one argument. The `=` forms keep an id or a text that starts with a dash a value.
 */
export const invocation = (sessionId: string, text: string): Invocation => ({
  program: "codex",
  args: ["queue", `--thread=${sessionId}`, `--message=${text}`, "--resume"]
})

// Unverified: the wording of the warning codex prints when the resume after queueing fails.
// Hand check: queue into a Codex thread that is not running and read the output.
const isResumeWarning = (output: string): boolean => /warn/i.test(output) && /resum/i.test(output)

export const interpret = (outcome: Outcome): Verdict => {
  switch (outcome._tag) {
    case "NotStarted":
      return failed(`codex could not start: ${outcome.reason}`)
    case "TimedOut":
      return failed(timedOutReason("codex", outcome))
    case "Exited": {
      // Unverified: a missing thread exits non-zero. Hand check: queue into an unknown thread id.
      if (outcome.exitCode !== 0) return failed(exitReason("codex", outcome))
      // codex help: "A failed resume produces a warning and the command still succeeds". The
      // message is queued in the thread, so the wake counts as delivered: a retry would queue it
      // twice. The warning travels as a note.
      const output = `${outcome.stderr}\n${outcome.stdout}`
      return isResumeWarning(output)
        ? delivered(`queued, but codex could not resume the thread: ${lastLine(outcome.stderr) ?? lastLine(outcome.stdout)}`)
        : delivered()
    }
  }
}
