import { fileURLToPath } from "node:url"
import { Effect, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { decodeSnapshot, gap, type ObservationGap, type Snapshot } from "./Reconcile.ts"

export interface Source<R = never> {
  readonly configure?: (values: Setup) => Effect.Effect<typeof Snapshot.Type, ObservationGap, R>
  readonly read: Effect.Effect<typeof Snapshot.Type, ObservationGap, R>
}

export interface Setup {
  readonly selectionToken: string
  readonly cachePath?: string
}

const bridge = (command: "configure" | "configured-snapshot", values?: Setup) => Effect.gen(function*() {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const child = yield* spawner.spawn(ChildProcess.make("python3", [
      fileURLToPath(new URL("../runtime/bridge.py", import.meta.url)), command
    ], { env: { PYTHONDONTWRITEBYTECODE: "1" }, extendEnv: true,
      stdin: values === undefined ? "ignore" : {
        stream: Stream.make(new TextEncoder().encode(JSON.stringify(values))), endOnDone: true
      }, stderr: "ignore", forceKillAfter: "1 second" }))
    let bytes = 0
    const decoder = new TextDecoder("utf-8", { fatal: true })
    const [text, code] = yield* Effect.all([
      child.stdout.pipe(Stream.runFoldEffect(() => "", (text, chunk) => Effect.try({
        try: () => {
          bytes += chunk.length
          if (bytes > 300000) throw gap()
          return text + decoder.decode(chunk, { stream: true })
        }, catch: gap
      }))), child.exitCode
    ], { concurrency: "unbounded" })
    if (code !== 0) return yield* gap()
    const parsed = yield* Effect.try({ try: () => JSON.parse(text + decoder.decode()) as unknown, catch: gap })
    return yield* decodeSnapshot(parsed)
  }).pipe(Effect.scoped, Effect.timeout("45 seconds"), Effect.mapError(gap))

export const localSource: Source<ChildProcessSpawner.ChildProcessSpawner> = {
  configure: (values) => bridge("configure", values),
  read: bridge("configured-snapshot")
}
