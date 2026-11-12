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

// codex-cli 0.167.2 without a local daemon or --remote server, for a thread that is closed and for
// one busy under `codex exec` alike (hand check, 2026-11-12), exits 0 and prints on stderr:
// "Warning: message was queued, but could not resume thread <id>: start a local daemon or specify
// a server with --remote". The message then waits in the queue and runs first when anything next
// resumes the thread. A busy `codex exec` run takes it as a new turn and aborts that turn when it
// exits, so the model never answers it; codex reports nothing back about that.
const isResumeWarning = (output: string): boolean => /warn/i.test(output) && /resum/i.test(output)

export const interpret = (outcome: Outcome): Verdict => {
  switch (outcome._tag) {
    case "NotStarted":
      return failed(`codex could not start: ${outcome.reason}`)
    case "TimedOut":
      return failed(timedOutReason("codex", outcome))
    case "Exited": {
      // An unknown or deleted thread exits 1 with "Error: failed to queue session message: …
      // no rollout found for thread id <id>", and a name that matches no session, such as "-nope",
      // with "Error: No active session found matching '-nope'." (hand check, 2026-11-12).
      if (outcome.exitCode !== 0) return failed(exitReason("codex", outcome))
      // The message sits in the thread's queue, so the wake counts as delivered: a retry would
      // queue it twice. The warning travels as a note.
      const output = `${outcome.stderr}\n${outcome.stdout}`
      return isResumeWarning(output)
        ? delivered(`queued; codex runs it when the thread next resumes: ${lastLine(outcome.stderr) ?? lastLine(outcome.stdout)}`)
        : delivered()
    }
  }
}
