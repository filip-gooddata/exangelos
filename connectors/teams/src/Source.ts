import { fileURLToPath } from "node:url"
import { Effect, Schema, Stream } from "effect"
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
  readonly read: (request: { scope: string; includeMessagePreview: boolean; cachePath?: string; account?: string }) =>
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
  29: "Copy a Teams message link containing its conversation ID and choose scope=conversation or scope=replies"
}
const unavailable = () => new SourceUnavailable({ reason: "Unable to verify Teams cache or private state. Check cachePath, access and Python 3 availability" })

const bridge = (command: "resolve" | "configured-snapshot", request: unknown) => Effect.gen(function*() {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const child = yield* spawner.spawn(ChildProcess.make("python3", [
    fileURLToPath(new URL("../runtime/bridge.py", import.meta.url)), command
  ], {
    env: { PYTHONDONTWRITEBYTECODE: "1" }, extendEnv: true,
    stdin: { stream: Stream.make(new TextEncoder().encode(JSON.stringify(request))), endOnDone: true },
    stderr: "ignore", forceKillAfter: "1 second"
  }))
  let bytes = 0
  const decoder = new TextDecoder("utf-8", { fatal: true })
  const [output, code] = yield* Effect.all([
    child.stdout.pipe(Stream.runFoldEffect(() => "", (text, chunk) => Effect.try({
      try: () => {
        bytes += chunk.length
        if (bytes > 5_000_000) throw unavailable()
        return text + decoder.decode(chunk, { stream: true })
      }, catch: unavailable
    }))), child.exitCode
  ], { concurrency: "unbounded" })
  if (code !== 0) return yield* new SourceUnavailable({ reason: reasons[code] ?? unavailable().reason })
  return yield* Effect.try({ try: () => JSON.parse(output + decoder.decode()) as unknown, catch: unavailable })
}).pipe(Effect.scoped, Effect.timeout("45 seconds"), Effect.mapError((error) =>
  error instanceof SourceUnavailable ? error : unavailable()))

export const localSource: Source<ChildProcessSpawner.ChildProcessSpawner> = {
  resolve: (values) => bridge("resolve", values).pipe(
    Effect.flatMap((input) => Schema.decodeUnknownEffect(Resolved)(input).pipe(Effect.mapError(unavailable)))
  ),
  read: (values) => bridge("configured-snapshot", values).pipe(Effect.flatMap(decodeSnapshot))
}
