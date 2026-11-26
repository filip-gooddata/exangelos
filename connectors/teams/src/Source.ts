import { fileURLToPath } from "node:url"
import { Cause, Effect, Schema, Stream } from "effect"
import { constants } from "node:os"
import type { PlatformError } from "effect/PlatformError"
import { childDetail, recordFailure, type Operation, type Outcome } from "./LastError.ts"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { decodeSnapshot, Token, type Snapshot, type ObservationGap } from "./Reconcile.ts"

const Resolved = Schema.Struct({
  scope: Token, label: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256))
})
export class SourceUnavailable extends Schema.TaggedError<SourceUnavailable>()("SourceUnavailable", {
  reason: Schema.String
}) {}
export interface Source<R = never> {
  readonly resolve: (request: { selection: string; scope?: string; cachePath?: string; account?: string }) =>
    Effect.Effect<typeof Resolved.Type, SourceUnavailable, R>
  readonly read: (request: { scope: string; includeMessagePreview: boolean; cachePath?: string; account?: string }, canRetry?: Effect.Effect<boolean>) =>
    Effect.Effect<typeof Snapshot.Type, ObservationGap | SourceUnavailable, R>
}
const reasons: Readonly<Record<number, string>> = {
  20: "Use a supported Teams conversation ID or message reference and check its scope",
  21: "Teams cache is unreadable or unsupported. Check access and configure cachePath for a compatible cache",
  22: "Reference was not found in this cache. Verify the conversation, account and locally available message",
  23: "Multiple cached sources match. Set account=tenantGUID/userGUID, narrow cachePath, or supply a tenant-specific reference",
  24: "Saved Teams selection no longer matches. Check the account and cachePath, then subscribe again with the original reference",
  27: "Choose scope=conversation for the whole conversation or scope=replies for its thread",
  28: "A reply thread cannot be verified for this reference. Use a supported channel thread or explicitly choose scope=conversation",
  29: "Copy a Teams message link containing its conversation ID and choose scope=conversation or scope=replies",
  30: "Teams cache manifest could not be read or validated",
  31: "Teams cache table files could not be read or validated",
  32: "Teams cache write-ahead log could not be read or validated",
  33: "Teams cache changed or became inaccessible during snapshot verification",
  34: "Teams cache inspection exceeded its time limit"
}
const unavailable = () => new SourceUnavailable({ reason: "Unable to verify Teams cache or private state. Check cachePath, access and Python 3 availability" })

const processOutcome = (stage: "spawn" | "stdout" | "exit", error: PlatformError): Outcome => {
  const cause = error.cause
  if (stage === "exit" && error.reason.method === "exitCode" && cause instanceof Error) {
    const signal = /^Process interrupted due to receipt of signal: '(SIG[A-Z0-9]+)'$/.exec(cause.message)?.[1]
    if (signal && Object.hasOwn(constants.signals, signal)) return { stage, signal }
  }
  const code = cause instanceof Error && "code" in cause ? cause.code : undefined
  return { stage: error.reason.method === "fromWritable(stdin)" ? "stdin" : stage, exception: "PlatformError", ...(typeof code === "string" && Object.hasOwn(constants.errno, code) ? { errno: code } : {}) }
}

const deadlineMs = 45_000

const runBridge = (command: Operation, request: unknown) => Effect.gen(function*() {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const child = yield* spawner.spawn(ChildProcess.make("python3", [
    fileURLToPath(new URL("../runtime/bridge.py", import.meta.url)), command, "--diagnostic"
  ], {
    env: { PYTHONDONTWRITEBYTECODE: "1" }, extendEnv: true,
    stdin: { stream: Stream.make(new TextEncoder().encode(JSON.stringify(request))), endOnDone: true },
    stderr: "ignore", forceKillAfter: "1 second"
  })).pipe(Effect.mapError(error => processOutcome("spawn", error)))
  let bytes = 0
  const decoder = new TextDecoder("utf-8", { fatal: true })
  const [output, code] = yield* Effect.all([
    child.stdout.pipe(
      Stream.mapError(error => processOutcome("stdout", error)),
      Stream.runFoldEffect(() => "", (text, chunk) => {
        bytes += chunk.length
        if (bytes > 5_000_000) return Effect.fail<Outcome>({ stage: "output-limit" })
        return Effect.try({ try: () => text + decoder.decode(chunk, { stream: true }), catch: (): Outcome => ({ stage: "utf8", exception: "TypeError" }) })
      })
    ), child.exitCode.pipe(Effect.mapError(error => processOutcome("exit", error)))
  ], { concurrency: "unbounded" })
  if (code !== 0) return yield* Effect.fail<Outcome>({ stage: "exit", exitCode: code, child: childDetail(output) })
  const tail = yield* Effect.try({ try: () => decoder.decode(), catch: (): Outcome => ({ stage: "utf8", exception: "TypeError" }) })
  return yield* Effect.try({ try: () => JSON.parse(output + tail) as unknown, catch: (): Outcome => ({ stage: "json", exception: "SyntaxError", exitCode: 0 }) })
}).pipe(Effect.scoped, Effect.timeout(deadlineMs), Effect.mapError((error): Outcome =>
  Cause.isTimeoutError(error) ? { stage: "deadline", exception: "TimeoutError" } : error))

const bridge = <A, E>(command: Operation, request: unknown, decode: (input: unknown) => Effect.Effect<A, E>,
  canRetry = Effect.succeed(false)) =>
  Effect.gen(function*() {
    const attempt = Effect.suspend(() => {
      const started = { wall: Date.now(), monotonic: performance.now() }
      return runBridge(command, request).pipe(
        Effect.tapError(outcome => Effect.sync(() => recordFailure(command, started, outcome))),
        Effect.map(input => ({ input, started }))
      )
    })
    const wallStart = Date.now()
    const { input, started } = yield* attempt.pipe(
      Effect.catchIf(outcome => command === "configured-snapshot" &&
        (outcome.stage === "deadline" || outcome.exitCode === 34) && Date.now() - wallStart >= 2 * deadlineMs,
        outcome => Effect.flatMap(canRetry, allowed => allowed ? attempt : Effect.fail(outcome))),
      Effect.mapError(outcome => {
        const reason = outcome.exitCode === undefined ? undefined : reasons[outcome.exitCode]
        return reason ? new SourceUnavailable({ reason }) : unavailable()
      })
    )
    return yield* decode(input).pipe(Effect.tapError(() =>
      Effect.sync(() => recordFailure(command, started, { stage: "schema", exception: "SchemaError", exitCode: 0 }))))
  })

export const localSource: Source<ChildProcessSpawner.ChildProcessSpawner> = {
  resolve: values => bridge("resolve", values, input => Schema.decodeUnknownEffect(Resolved)(input).pipe(Effect.mapError(unavailable))),
  read: (values, canRetry) => bridge("configured-snapshot", values, decodeSnapshot, canRetry)
}
