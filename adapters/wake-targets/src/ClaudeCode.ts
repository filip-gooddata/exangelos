import type { Invocation, Outcome, Verdict } from "./Attempt.ts"
import { delivered, exitReason, failed, lastLine, timedOutReason } from "./Attempt.ts"

/**
 * `claude --bg --resume=<id> -- <text>`. `--bg` continues the session in the background and returns
 * at once, where `-p` would wait for a whole turn. The `=` form keeps an id that starts with a dash a
 * value, and `--` keeps the text a prompt.
 *
 * Unverified: that `--bg --resume` takes the prompt as an argument and that the text reaches the
 * conversation the person sees, from the daemon's working directory and environment, and that the
 * background session outlives the end of claude's process group (see `Attempt.run`). Hand check:
 * resume an idle session with a harmless text from another directory, then open it.
 */
export const invocation = (sessionId: string, text: string): Invocation => ({
  program: "claude",
  args: ["--bg", `--resume=${sessionId}`, "--", text]
})

// claude help: with --resume, --bg "starts a copy and says so when the session is already running".
// Unverified: the wording. Hand check: resume a session that is open in a terminal.
const startedCopy = /\bcopy\b/i

export const interpret = (outcome: Outcome): Verdict => {
  switch (outcome._tag) {
    case "NotStarted":
      return failed(`claude could not start: ${outcome.reason}`)
    case "TimedOut":
      return failed(timedOutReason("claude", outcome))
    case "Exited": {
      // Unverified: an unknown session id exits non-zero. Hand check: resume an unknown id.
      if (outcome.exitCode !== 0) return failed(exitReason("claude", outcome))
      // A copy of the session got the text and runs on it. A retry would start another copy, so
      // the wake counts as delivered and the copy travels as a note.
      const output = `${outcome.stdout}\n${outcome.stderr}`
      return startedCopy.test(output)
        ? delivered(`claude started a copy of the running session: ${lastLine(outcome.stdout) ?? lastLine(outcome.stderr)}`)
        : delivered()
    }
  }
}
