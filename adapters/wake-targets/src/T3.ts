import { Duration, Option, Schema } from "effect"
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

/**
 * How long a send may run. `t3 thread send` took 29 to 52 seconds on a loaded machine (2026-11-25), and
 * a send killed at the limit may already have reached the thread, so its retry repeats the wake. t3
 * 0.1.7 takes no request id to dedupe on, so the limit sits well above that.
 */
export const limit = Duration.minutes(2)

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

/**
 * `t3 thread show --json --messages 0 -- <thread>`: the thread without its messages. A known thread
 * exits 0 with `{ "thread": { "threadId", "title", ... }, "messages": [] }`; an unknown one exits 1
 * with "Thread <id> is no longer available." (hand check, 2026-11-23).
 */
export const titleInvocation = (sessionId: string): Invocation => ({
  program: "t3",
  args: ["--log-level", "fatal", "thread", "show", "--json", "--messages", "0", "--", sessionId]
})

const Shown = Schema.Struct({ thread: Schema.Struct({ title: Schema.String }) })
const decodeShown = Schema.decodeUnknownOption(Shown)

const parsed = (text: string): Option.Option<unknown> => {
  try {
    return Option.some(JSON.parse(text))
  } catch {
    return Option.none()
  }
}

/** The JSON document in t3's output, after any log lines t3 printed before it. */
const document = (stdout: string): Option.Option<unknown> => {
  const whole = parsed(stdout)
  if (Option.isSome(whole)) return whole
  const start = stdout.search(/^\{/m)
  return start < 0 ? Option.none() : parsed(stdout.slice(start))
}

/** The thread's title, trimmed. A failed run, output that isn't a thread or a blank title is none. */
export const title = (outcome: Outcome): Option.Option<string> =>
  outcome._tag !== "Exited" || outcome.exitCode !== 0
    ? Option.none()
    : document(outcome.stdout).pipe(
      Option.flatMap(decodeShown),
      Option.map((shown) => shown.thread.title.trim()),
      Option.filter((text) => text.length > 0)
    )
