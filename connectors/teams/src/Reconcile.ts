import { fileURLToPath } from "node:url"
import { Clock, Effect, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

export const Token = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
const fields = { id: Token, body: Token, parent: Schema.NullOr(Token), reaction: Schema.NullOr(Token),
  reactions: Schema.NullOr(Schema.Array(Token).check(Schema.isMaxLength(500))) }
const Message = Schema.Struct(fields)
export const Snapshot = Schema.Struct({
  scope: Token,
  messages: Schema.Array(Message).check(Schema.isMinLength(1), Schema.isMaxLength(500))
})
export class ObservationGap extends Schema.TaggedError<ObservationGap>()("ObservationGap", {
  reason: Schema.Literal("Teams observation or resume state is unavailable, unsupported, or inconsistent")
}) {}
export const gap = () => new ObservationGap({ reason: "Teams observation or resume state is unavailable, unsupported, or inconsistent" })
const EventType = Schema.Literals(["message.new", "message.reply", "message.edited", "reaction.added", "reaction.removed"])
export type EventType = typeof EventType.Type
const Result = Schema.Struct({
  events: Schema.Array(Schema.Struct({ type: EventType, occurredAt: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 8640000000000000 })), dedupeKey: Schema.String.check(Schema.isMaxLength(512)) }))
    .check(Schema.isMaxLength(500500)),
  cursor: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512))
})

export const decodeSnapshot = (input: unknown) => Schema.decodeUnknownEffect(Snapshot)(input).pipe(Effect.mapError(gap))

export const reconcile = (scope: string, cursor: string | undefined, input: unknown) => Effect.gen(function*() {
  const snapshot = yield* decodeSnapshot(input)
  if (snapshot.scope !== scope) return yield* gap()
  if (cursor !== undefined && cursor.length > 512) return yield* gap()
  const observedAt = yield* Clock.currentTimeMillis
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const child = yield* spawner.spawn(ChildProcess.make("python3", [
    fileURLToPath(new URL("../runtime/ledger.py", import.meta.url))
  ], {
    env: { PYTHONDONTWRITEBYTECODE: "1" }, extendEnv: true,
    stdin: { stream: Stream.make(new TextEncoder().encode(JSON.stringify({ cursor, snapshot, observedAt }) + "\n")), endOnDone: true },
    stderr: "ignore", forceKillAfter: "1 second"
  }))
  let bytes = 0
  const decoder = new TextDecoder("utf-8", { fatal: true })
  const [text, code] = yield* Effect.all([
    child.stdout.pipe(Stream.runFoldEffect(() => "", (text, chunk) => Effect.try({
      try: () => {
        bytes += chunk.length
        if (bytes > 256000000) throw gap()
        return text + decoder.decode(chunk, { stream: true })
      }, catch: gap
    }))), child.exitCode
  ], { concurrency: "unbounded" })
  if (code !== 0) return yield* gap()
  const result = yield* Effect.try({ try: () => JSON.parse(text + decoder.decode()) as unknown, catch: gap })
  return yield* Schema.decodeUnknownEffect(Result)(result)
}).pipe(Effect.scoped, Effect.timeout("45 seconds"), Effect.mapError(gap))
