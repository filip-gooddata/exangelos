import { fileURLToPath } from "node:url"
import { Effect, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

const Token = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
const Identifier = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256))
const VolumeAlias = Schema.Tuple([Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/)), Schema.Int])
export const Request = Schema.Struct({
  selection: Schema.Struct({
    workspace: Identifier,
    owner: Identifier,
    thread: Schema.optional(Identifier),
    conversations: Schema.Array(Identifier).check(Schema.isMinLength(1), Schema.isMaxLength(500))
  }),
  key: Token,
  volumeIdentity: Schema.optionalKey(Schema.Union([
    Schema.Struct({ kind: Schema.Literal("volume") }),
    Schema.Struct({ kind: Schema.Literal("legacy"), root: VolumeAlias, database: VolumeAlias })
  ])),
  expectedScope: Schema.optional(Token),
  root: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)))
})
const Resolved = Schema.Struct({
  ...Request.fields,
  expectedScope: Token,
  label: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256))
})
export const MessageContext = Schema.Struct({
  messageTs: Schema.String.check(Schema.isPattern(/^[0-9]{1,20}\.[0-9]{1,10}$/)),
  conversationLabel: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  permalink: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
  preview: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(320))),
  sender: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(160)))
})
export const Snapshot = Schema.Struct({
  scope: Token,
  complete: Schema.Literal(true),
  messages: Schema.Array(Schema.Struct({
    ...MessageContext.fields,
    memberSender: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(160))),
    memberPeer: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(160))),
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
  20: "Use a D/C/G conversation ID, Slack message permalink, timestamp, or CHANNEL:TIMESTAMP. For a message use scope=conversation or scope=replies",
  21: "Slack cache or private setup files are missing or unreadable. Check the cache root and access",
  22: "No matching conversation or message in this persisted cache. Check the reference and cache root. For an unverified permalink domain, use CHANNEL:TIMESTAMP",
  23: "Multiple cached sources matched. Specify CHANNEL:TIMESTAMP or narrow cacheRoot to one source",
  24: "The saved Slack scope or cache changed. Check cacheRoot and subscribe again using the original conversation ID or message reference",
  25: "Another Slack setup is running. Retry Subscribe",
  26: "Configure subscriptionAccess=persisted-cache and retry with a Slack conversation ID or message reference",
  27: 'Top-level message. For the whole conversation retry exangelos subscribe slack "<reference>" scope=conversation --intent "<intent>" --pull-only. For its replies use scope=replies. In MCP subscribe, set parameters to {"selection":"<reference>","scope":"conversation"} or {"selection":"<reference>","scope":"replies"}'
}
export class SourceUnavailable extends Schema.TaggedError<SourceUnavailable>()("SourceUnavailable", {
  reason: Schema.String,
  category: Schema.optionalKey(Schema.Literals(["unavailable", "unreadable", "invalid-data", "scope-changed"]))
}) {}
const exitCategories: Readonly<Record<number, SourceUnavailable["category"]>> = {
  1: "invalid-data", 21: "unreadable", 24: "scope-changed"
}
const unavailable = () => new SourceUnavailable({ reason: snapshotReason, category: "unavailable" })
const invalid = () => new SourceUnavailable({ reason: snapshotReason, category: "invalid-data" })
export interface Source<R = never> {
  readonly setup: (values: Readonly<Record<string, string>>) => Effect.Effect<typeof Resolved.Type, SourceUnavailable, R>
  readonly read: (request: typeof Request.Type & { readonly includePreview?: true }) => Effect.Effect<typeof Snapshot.Type, SourceUnavailable, R>
}
const decodeResolved = (text: string) => Effect.gen(function*() {
  if (text.length > 65536) return yield* unavailable()
  const input = yield* Effect.try({ try: () => JSON.parse(text) as unknown, catch: unavailable })
  const request = yield* Schema.decodeUnknownEffect(Resolved)(input).pipe(Effect.mapError(unavailable))
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
          if (bytes > 5_000_000) throw unavailable()
          return text + decoder.decode(chunk, { stream: true })
        }, catch: unavailable
      }))), child.exitCode
    ], { concurrency: "unbounded" })
    if (code !== 0) return yield* new SourceUnavailable({
      category: exitCategories[code] ?? "unavailable",
      reason: script === "setup" ? setupReasons[code] ?? snapshotReason : snapshotReason })
    return text + decoder.decode()
  }).pipe(Effect.scoped, Effect.timeout("45 seconds"), Effect.mapError((error) => error instanceof SourceUnavailable ? error : unavailable()))

export const localSource: Source<ChildProcessSpawner.ChildProcessSpawner> = {
  setup: (values) => runPython("setup", values).pipe(Effect.flatMap(decodeResolved)),
  read: (request) => runPython("source", request).pipe(
    Effect.flatMap((text) => Effect.try({ try: () => JSON.parse(text) as unknown, catch: invalid })),
    Effect.flatMap((input) => Schema.decodeUnknownEffect(Snapshot)(input).pipe(Effect.mapError(invalid)))
  )
}
