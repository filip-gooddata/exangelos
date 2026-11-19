import { Duration, Effect, Option, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

/** One run of a delivery tool, as an argument list. No shell sees any part of it. */
export interface Invocation {
  readonly program: string
  readonly args: ReadonlyArray<string>
  /** Written to the tool's stdin, then stdin closes. Without it the tool gets an empty stdin. */
  readonly stdin?: string
  /** Added to the daemon's environment. */
  readonly env?: Readonly<Record<string, string>>
}

/** What came back from one run. */
export type Outcome =
  | { readonly _tag: "Exited"; readonly exitCode: number; readonly stdout: string; readonly stderr: string }
  | { readonly _tag: "TimedOut"; readonly limit: Duration.Duration }
  | { readonly _tag: "NotStarted"; readonly reason: string }

export type Verdict =
  | { readonly _tag: "Delivered"; readonly note?: string }
  | { readonly _tag: "Failed"; readonly reason: string }

export const delivered = (note?: string): Verdict => note === undefined ? { _tag: "Delivered" } : { _tag: "Delivered", note }
export const failed = (reason: string): Verdict => ({ _tag: "Failed", reason })

const longest = 300

/** How much of each output stream an attempt keeps. The rest is read and dropped. */
const kept = 16 * 1024

const tail = <E>(output: Stream.Stream<Uint8Array, E>): Effect.Effect<string, E> =>
  Stream.decodeText(output).pipe(
    Stream.runFold(() => "", (text: string, chunk: string) => {
      const joined = text + chunk
      return joined.length > kept ? joined.slice(-kept) : joined
    })
  )

/** The last non-empty line of the text, shortened, for a failure reason. */
export const lastLine = (text: string): string | undefined => {
  const line = text.split("\n").map((part) => part.trim()).filter((part) => part.length > 0).at(-1)
  return line === undefined ? undefined : line.length > longest ? `${line.slice(0, longest)}…` : line
}

/** The usual failure reason for a non-zero exit: the tool's own last word, else the code. */
export const exitReason = (program: string, outcome: Extract<Outcome, { _tag: "Exited" }>): string => {
  const said = lastLine(outcome.stderr) ?? lastLine(outcome.stdout)
  return said === undefined ? `${program} exited with ${outcome.exitCode}` : `${program} exited with ${outcome.exitCode}: ${said}`
}

export const timedOutReason = (program: string, outcome: Extract<Outcome, { _tag: "TimedOut" }>): string =>
  `${program} did not finish within ${Duration.format(outcome.limit)}`

export const quietReason = (program: string, outcome: Outcome): string => {
  switch (outcome._tag) {
    case "Exited":
      return `${program} exited with ${outcome.exitCode}`
    case "TimedOut":
      return timedOutReason(program, outcome)
    case "NotStarted":
      return `${program} did not start`
  }
}

const logOutcome = (outcome: Outcome, durationMs: number) =>
  Effect.logDebug("wake command finished").pipe(
    Effect.annotateLogs({
      result: outcome._tag,
      durationMs,
      ...(outcome._tag === "Exited" ? { exitCode: outcome.exitCode } : {})
    })
  )

/**
 * Runs the invocation once and gives up at the limit. The process is killed when it runs over. When
 * the scope closes, the spawner also ends what is left of the tool's process group, so a tool that
 * keeps working in the background must detach that work itself.
 */
export const run = (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  invocation: Invocation,
  limit: Duration.Duration
): Effect.Effect<Outcome> =>
  Effect.gen(function*() {
    const command = ChildProcess.make(invocation.program, invocation.args, {
      stdin: Stream.encodeText(Stream.make(invocation.stdin ?? "")),
      ...(invocation.env === undefined ? {} : { env: invocation.env, extendEnv: true }),
      forceKillAfter: Duration.seconds(2)
    })
    return yield* Effect.scoped(Effect.gen(function*() {
      const handle = yield* spawner.spawn(command)
      const [stdout, stderr, exitCode] = yield* Effect.all([
        tail(handle.stdout),
        tail(handle.stderr),
        handle.exitCode
      ], { concurrency: "unbounded" })
      return { _tag: "Exited", exitCode, stdout, stderr } as Outcome
    }))
  }).pipe(
    Effect.timeoutOption(limit),
    Effect.map(Option.getOrElse((): Outcome => ({ _tag: "TimedOut", limit }))),
    Effect.catch((error) => Effect.succeed<Outcome>({ _tag: "NotStarted", reason: error.message })),
    Effect.timed,
    Effect.tap(([duration, outcome]) => logOutcome(outcome, Duration.toMillis(duration))),
    Effect.map(([, outcome]) => outcome)
  )
