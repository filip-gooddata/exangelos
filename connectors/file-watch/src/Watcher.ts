import { Clock, Deferred, Duration, Effect, Exit, FileSystem, Option, Ref, Schedule, Stream } from "effect"
import * as Baseline from "./Baseline.ts"
import { type FileGlob, relativeTo } from "./FileGlob.ts"
import * as Settle from "./Settle.ts"
import * as Tree from "./Tree.ts"

/** Changes found together and the cursor that covers them. */
export interface Batch {
  readonly changes: ReadonlyArray<Baseline.Change>
  readonly cursor: string
}

export interface Options {
  /** How long notices for one path gather before the connector looks at it once. */
  readonly settle: Duration.Duration
}

/** How far before an observation a cursor starts, to cover notices still in flight. */
const slack = 2000

type Step =
  | { readonly _tag: "Batch"; readonly batch: Batch }
  | { readonly _tag: "Restart" }

const restart: Step = { _tag: "Restart" }

const waitForBase = (glob: FileGlob, poll: Duration.Duration) =>
  Effect.gen(function*() {
    while (!(yield* Tree.baseExists(glob).pipe(Effect.orElseSucceed(() => false)))) yield* Effect.sleep(poll)
  })

/**
 * Starts from what the baseline knew: reports what changed meanwhile, then
 * watches. Without a baseline, the first scan is taken silently. A missing
 * base directory reports what was known as deleted and waits for it.
 */
const run = (
  glob: FileGlob,
  baseline: Baseline.Baseline | undefined,
  options: Options
): Stream.Stream<Batch, never, FileSystem.FileSystem> =>
  Stream.unwrap(Effect.gen(function*() {
    if (yield* Tree.baseExists(glob).pipe(Effect.retry(Schedule.spaced(options.settle)), Effect.orDie)) {
      return live(glob, baseline, options)
    }
    const started = yield* Clock.currentTimeMillis
    const deleted = baseline === undefined ? [] : Baseline.diff(baseline, new Map())
    const missing = Stream.make<[Batch]>({ changes: deleted, cursor: Baseline.encodeCursor(new Map(), started - slack) })
    const waited = Stream.fromEffect(waitForBase(glob, options.settle)).pipe(Stream.drain)
    return missing.pipe(Stream.concat(waited), Stream.concat(Stream.suspend(() => run(glob, Baseline.empty, options))))
  }))

/**
 * Watches the base directory. The scan runs once the watcher is ready, so a
 * change between the two is noticed rather than lost.
 */
const live = (
  glob: FileGlob,
  baseline: Baseline.Baseline | undefined,
  options: Options
): Stream.Stream<Batch, never, FileSystem.FileSystem> =>
  Stream.unwrap(Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const window = Duration.toMillis(options.settle)
    const ready = yield* Deferred.make<void>()
    const state = yield* Ref.make({ files: new Map() as Tree.Snapshot, pending: Settle.none })

    const noticed = (path: string): Effect.Effect<ReadonlyArray<Step>> =>
      Effect.gen(function*() {
        const relative = path.startsWith("/") ? relativeTo(glob.base, path) : path
        if (relative === undefined) return []
        const now = yield* Clock.currentTimeMillis
        yield* Ref.update(state, (current) => ({ ...current, pending: Settle.notice(current.pending, relative, now) }))
        return []
      })

    const start: Effect.Effect<ReadonlyArray<Step>, never, FileSystem.FileSystem> = Effect.gen(function*() {
      yield* Deferred.await(ready)
      const started = yield* Clock.currentTimeMillis
      const files = yield* Tree.scan(glob).pipe(Effect.retry(Schedule.spaced(options.settle)), Effect.orDie)
      yield* Ref.update(state, (current) => ({ ...current, files }))
      const changes = baseline === undefined ? [] : Baseline.diff(baseline, files)
      return [{ _tag: "Batch", batch: { changes, cursor: Baseline.encodeCursor(files, started - slack) } }]
    })

    const tick: Effect.Effect<ReadonlyArray<Step>, never, FileSystem.FileSystem> = Effect.gen(function*() {
      const exists = yield* Tree.baseExists(glob).pipe(Effect.option)
      if (Option.isNone(exists)) return []
      if (!exists.value) return [restart]
      const now = yield* Clock.currentTimeMillis
      const due = yield* Ref.modify(state, (current) => {
        const { due, pending } = Settle.settled(current.pending, now, window)
        return [due, { ...current, pending }] as const
      })
      if (due.length === 0) return []
      let known = (yield* Ref.get(state)).files
      const changes: Array<Baseline.Change> = []
      for (const path of due) {
        const observed = yield* Tree.observe(glob, path).pipe(Effect.option)
        if (Option.isNone(observed)) {
          yield* Ref.update(state, (current) => ({ ...current, pending: Settle.notice(current.pending, path, now) }))
          continue
        }
        changes.push(...Baseline.diff({ _tag: "Known", files: known }, observed.value, path))
        known = Baseline.update(known, observed.value, path)
      }
      const { pending } = yield* Ref.updateAndGet(state, (current) => ({ ...current, files: known }))
      if (changes.length === 0) return []
      const from = Math.min(now, Settle.earliest(pending) ?? now) - slack
      return [{ _tag: "Batch", batch: { changes, cursor: Baseline.encodeCursor(known, from) } }]
    })

    const notices = fs.watch(glob.base, {
      recursive: glob.depth > 1,
      onReady: () => Deferred.doneUnsafe(ready, Exit.void)
    }).pipe(
      Stream.mapEffect((event) => noticed(event.path)),
      Stream.catch(() => Stream.make<[ReadonlyArray<Step>]>([restart]))
    )
    const ticks = Stream.fromEffect(start).pipe(
      Stream.concat(Stream.tick(Duration.millis(Math.max(10, window / 4))).pipe(Stream.mapEffect(() => tick)))
    )
    const batches = Stream.merge(notices, ticks).pipe(
      Stream.flattenIterable,
      Stream.takeUntil((step: Step) => step._tag === "Restart"),
      Stream.map((step) => step._tag === "Batch" ? [step.batch] : []),
      Stream.flattenIterable
    )
    const restarted = Stream.unwrap(
      Effect.sleep(options.settle).pipe(
        Effect.andThen(Ref.get(state)),
        Effect.map(({ files }) => run(glob, { _tag: "Known", files }, options))
      )
    )
    return Stream.concat(batches, restarted)
  }))

/** Watches the files a glob matches, resuming from a cursor when one is given. */
export const watch = (glob: FileGlob, cursor: string | undefined, options: Options) =>
  run(glob, Baseline.decodeCursor(cursor), options)
