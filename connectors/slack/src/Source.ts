import { fileURLToPath } from "node:url"
import { Effect, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

const Token = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
const Identifier = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256))
export const Request = Schema.Struct({
  selection: Schema.Struct({
    workspace: Identifier,
    owner: Identifier,
    conversations: Schema.Array(Identifier).check(Schema.isMinLength(1), Schema.isMaxLength(500))
  }),
  key: Token,
  expectedScope: Schema.optional(Token),
  root: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)))
})
export const Snapshot = Schema.Struct({
  scope: Token,
  complete: Schema.Literal(true),
  messages: Schema.Array(Schema.Struct({
    id: Token, body: Token, reply: Schema.Boolean,
    reactions: Schema.Array(Token).check(Schema.isMaxLength(100)),
    reactionsComplete: Schema.Boolean
  })).check(Schema.isMaxLength(500)),
  generation: Schema.String.check(Schema.isPattern(/^(0|[1-9][0-9]{0,19})$/)),
  snapshot: Token
})
const snapshotReason = "Slack persisted snapshot is unavailable or unsupported"
const setupReasons: Readonly<Record<number, string>> = {
  1: "Slack setup could not validate private state or a stable, supported persisted snapshot",
  20: "Initial setup needs one secret selector: a literal snippet, conversation ID or supported Slack link",
  21: "Slack cache or private setup files are missing or unreadable. Check the cache root and access",
  22: "No conversation matched in the persisted cache. Try its conversation ID or check the cache root",
  23: "Multiple cached accounts or conversations matched. Narrow the cache root or selector",
  24: "Pinned selection or cache changed. Restore its settings or deliberately change the selection revision",
  25: "Another Slack setup is running. Retry Configure",
  26: "Pinned-cache mode accepts no selector. Use persisted-cache for initial selection"
}
export class SourceUnavailable extends Schema.TaggedError<SourceUnavailable>()("SourceUnavailable", {
  reason: Schema.String
}) {}
const unavailable = () => new SourceUnavailable({ reason: snapshotReason })
export interface Source<R = never> {
  readonly setup?: (values: Readonly<Record<string, string>>) => Effect.Effect<typeof Request.Type, SourceUnavailable, R>
  readonly read: (request: typeof Request.Type) => Effect.Effect<typeof Snapshot.Type, SourceUnavailable, R>
}
export const decodeRequest = (text: string) => Effect.gen(function*() {
  if (text.length > 65536) return yield* unavailable()
  const input = yield* Effect.try({ try: () => JSON.parse(text) as unknown, catch: unavailable })
  const request = yield* Schema.decodeUnknownEffect(Request)(input).pipe(Effect.mapError(unavailable))
  if (new Set(request.selection.conversations).size !== request.selection.conversations.length) return yield* unavailable()
  return request
})
const runPython = (script: "source" | "setup", request: unknown) => Effect.gen(function*() {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const child = yield* spawner.spawn(ChildProcess.make("python3", [
      fileURLToPath(new URL(`../direct/${script}.py`, import.meta.url))
    ], {
      env: { PYTHONDONTWRITEBYTECODE: "1" }, extendEnv: true,
      stdin: { stream: Stream.make(new TextEncoder().encode(JSON.stringify(request) + "\n")), endOnDone: true },
      stderr: "ignore", forceKillAfter: "1 second"
    }))
    let bytes = 0
    const decoder = new TextDecoder("utf-8", { fatal: true })
    const [text, code] = yield* Effect.all([
      child.stdout.pipe(Stream.runFoldEffect(() => "", (text, chunk) => Effect.try({
        try: () => {
          bytes += chunk.length
          if (bytes > 4000000) throw unavailable()
          return text + decoder.decode(chunk, { stream: true })
        }, catch: unavailable
      }))), child.exitCode
    ], { concurrency: "unbounded" })
    if (code !== 0) return yield* new SourceUnavailable({ reason: script === "setup"
      ? setupReasons[code] ?? snapshotReason : snapshotReason })
    return text + decoder.decode()
  }).pipe(Effect.scoped, Effect.timeout("45 seconds"), Effect.mapError((error) => error instanceof SourceUnavailable ? error : unavailable()))

export const localSource: Source<ChildProcessSpawner.ChildProcessSpawner> = {
  setup: (values) => runPython("setup", values).pipe(Effect.flatMap(decodeRequest)),
  read: (request) => runPython("source", request).pipe(
    Effect.flatMap((text) => Effect.try({ try: () => JSON.parse(text) as unknown, catch: unavailable })),
    Effect.flatMap(Schema.decodeUnknownEffect(Snapshot)),
    Effect.mapError(unavailable)
  )
}
