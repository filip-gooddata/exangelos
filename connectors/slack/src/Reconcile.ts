import { fileURLToPath } from "node:url"
import { Clock, Effect, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { Snapshot } from "./Source.ts"

export class ObservationGap extends Schema.TaggedError<ObservationGap>()("ObservationGap", {
  reason: Schema.Literal("Slack observation or cursor is incomplete, unsupported, or inconsistent")
}) {}

const EventType = Schema.Literals(["message.new", "thread.reply", "message.edited", "reaction.added", "reaction.removed"])
export type EventType = typeof EventType.Type
const Result = Schema.Struct({
  events: Schema.Array(Schema.Struct({ type: EventType, occurredAt: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 8640000000000000 })), dedupeKey: Schema.String.check(Schema.isMaxLength(512)) }))
    .check(Schema.isMaxLength(100500)),
  cursor: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512))
})
const gap = () => new ObservationGap({ reason: "Slack observation or cursor is incomplete, unsupported, or inconsistent" })

export const validateObservation = (input: unknown) => Effect.gen(function*() {
  const snapshot = yield* Schema.decodeUnknownEffect(Snapshot)(input).pipe(Effect.mapError(gap))
  if (new Set(snapshot.messages.map((message) => message.id)).size !== snapshot.messages.length ||
    snapshot.messages.some((message) => new Set(message.reactions).size !== message.reactions.length)) return yield* gap()
  return snapshot
})

export const reconcile = (cursor: string | undefined, input: unknown) => Effect.gen(function*() {
  const snapshot = yield* validateObservation(input)
  if (cursor !== undefined && cursor.length > 512) return yield* gap()
  const observedAt = yield* Clock.currentTimeMillis
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const child = yield* spawner.spawn(ChildProcess.make("python3", [
    fileURLToPath(new URL("../direct/ledger.py", import.meta.url))
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
        if (bytes > 64000000) throw gap()
        return text + decoder.decode(chunk, { stream: true })
      }, catch: gap
    }))), child.exitCode
  ], { concurrency: "unbounded" })
  if (code !== 0) return yield* gap()
  const result = yield* Effect.try({ try: () => JSON.parse(text + decoder.decode()) as unknown, catch: gap })
  return yield* Schema.decodeUnknownEffect(Result)(result)
}).pipe(Effect.scoped, Effect.timeout("45 seconds"), Effect.mapError(gap))
