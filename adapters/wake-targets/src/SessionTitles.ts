import { Cache, Duration, Effect, Exit, FileSystem, Layer, Option, Path, Random, Schema, Scope, Semaphore } from "effect"
import { ChildProcessSpawner } from "effect/process"
import { SessionTitles } from "@exangelos/application"
import { Session } from "@exangelos/domain"
import type { Invocation, Outcome } from "./Attempt.ts"
import { run } from "./Attempt.ts"
import * as Executable from "./Executable.ts"
import * as T3 from "./T3.ts"

/** How one harness names a session: the CLI run that shows it and the title read from that run. */
interface Resolver {
  readonly invocation: (sessionId: string) => Invocation
  readonly title: (outcome: Outcome) => Option.Option<string>
}

/** Harnesses whose CLI can name a session. Codex, Claude Code and named harnesses have none yet. */
const resolvers: Readonly<Partial<Record<Session.Harness, Resolver>>> = {
  t3: { invocation: T3.titleInvocation, title: T3.title }
}

/** Where the last title found for each session is kept, so a failed refresh or a restarted daemon still shows it. */
export interface Memory {
  readonly load: Effect.Effect<ReadonlyArray<Session.SessionTitle>>
  readonly save: (titles: ReadonlyArray<Session.SessionTitle>) => Effect.Effect<void>
}

const Remembered = Schema.fromJsonString(Schema.Array(Session.SessionTitle))

/** A {@link Memory} in a JSON file, replaced whole on each save. A missing or unreadable file remembers nothing. */
export const fileMemory = (file: string): Effect.Effect<Memory, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const load = fs.readFileString(file).pipe(
      Effect.flatMap(Schema.decodeEffect(Remembered)),
      Effect.catch((error) =>
        error._tag === "PlatformError" && error.reason._tag === "NotFound"
          ? Effect.succeed<ReadonlyArray<Session.SessionTitle>>([])
          : Effect.logWarning("session titles could not be read").pipe(
            Effect.annotateLogs({ file, reason: error.message }),
            Effect.as<ReadonlyArray<Session.SessionTitle>>([])
          )
      )
    )
    const save = (titles: ReadonlyArray<Session.SessionTitle>) =>
      Effect.gen(function*() {
        const temp = `${file}.${yield* Random.nextInt}.tmp`
        yield* fs.makeDirectory(path.dirname(file), { recursive: true })
        yield* fs.writeFileString(temp, `${JSON.stringify(titles)}\n`)
        yield* fs.rename(temp, file)
      }).pipe(
        Effect.catch((error) =>
          Effect.logWarning("session titles could not be saved").pipe(Effect.annotateLogs({ file, reason: error.message }))
        )
      )
    return { load, save }
  })

export interface Options {
  /** How long one lookup may run once it has its turn. Default 15 seconds. */
  readonly limit?: Duration.Input
  /** How long a found title is kept. Default 10 minutes, so a renamed thread shows its new title. */
  readonly found?: Duration.Input
  /** How long a session without a title is kept. Default 2 minutes, so a broken CLI isn't run on every poll. */
  readonly missing?: Duration.Input
  /** How many lookups run at once, across every poll. Default 2. */
  readonly concurrency?: number
  /** Where the harness CLIs are looked up, read at each lookup. Default the daemon's environment and file system. */
  readonly lookup?: () => Executable.Lookup
  /** Where the last found titles are kept. Default nowhere: they last as long as the daemon. */
  readonly memory?: Memory
}

const separator = "\u0000"

const capacity = 1024

const keyOf = (session: Session.Target) => `${session.harness}${separator}${session.sessionId}`

const named = (session: Session.Target) => (title: string): Session.SessionTitle => ({
  harness: session.harness,
  sessionId: session.sessionId,
  title
})

export interface Titles {
  /**
   * The titles already known, at once. Sessions not looked up yet, or whose entry expired, are looked up in the background.
   * A session whose refresh failed keeps the last title found for it.
   */
  readonly titles: (sessions: ReadonlyArray<Session.Target>) => Effect.Effect<ReadonlyArray<Session.SessionTitle>>
  /** Looks up every session not known yet and waits for the answers. */
  readonly lookup: (sessions: ReadonlyArray<Session.Target>) => Effect.Effect<ReadonlyArray<Session.SessionTitle>>
}

/**
 * Titles found through each harness's CLI and kept in the daemon's memory. Concurrent lookups of
 * one session share a run, and at most `concurrency` runs go at once so a burst doesn't time itself out.
 * The last title found for a session stays until a later lookup finds another, so a timed-out or failed
 * refresh still shows it; `memory` keeps those across restarts. A session never named is left out.
 * Background lookups live as long as `Scope`.
 */
export const make = (
  options: Options = {}
): Effect.Effect<Titles, never, ChildProcessSpawner.ChildProcessSpawner | Scope.Scope> =>
  Effect.gen(function*() {
    const scope = yield* Scope.Scope
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const where = options.lookup ?? Executable.system
    const limit = Duration.fromInputUnsafe(options.limit ?? Duration.seconds(15))
    const found = Duration.fromInputUnsafe(options.found ?? Duration.minutes(10))
    const missing = Duration.fromInputUnsafe(options.missing ?? Duration.minutes(2))
    const runs = yield* Semaphore.make(options.concurrency ?? 2)
    const writes = yield* Semaphore.make(1)
    const memory = options.memory

    const last = new Map<string, string>()
    for (const known of memory === undefined ? [] : yield* memory.load) last.set(keyOf(known), known.title)

    const snapshot = () =>
      Array.from(last, ([key, title]) => {
        const [harness = "", sessionId = ""] = key.split(separator)
        return { harness, sessionId, title }
      })

    const remember = (key: string, title: string) =>
      Effect.suspend(() => {
        if (last.get(key) === title) return Effect.void
        last.delete(key)
        last.set(key, title)
        for (const oldest of last.keys()) {
          if (last.size <= capacity) break
          last.delete(oldest)
        }
        return memory === undefined ? Effect.void : Semaphore.withPermit(writes, Effect.suspend(() => memory.save(snapshot())))
      })

    const lastTitle = (session: Session.Target) => Option.fromUndefinedOr(last.get(keyOf(session)))

    const resolve = (key: string): Effect.Effect<Option.Option<string>> => {
      const [harness = "", sessionId = ""] = key.split(separator)
      const resolver = Object.hasOwn(resolvers, harness) ? resolvers[harness as Session.Harness] : undefined
      if (resolver === undefined) return Effect.succeedNone
      return Effect.gen(function*() {
        const located = Executable.locate(resolver.invocation(sessionId), where())
        const outcome = "_tag" in located ? located : yield* Semaphore.withPermit(runs, run(spawner, located, limit))
        const title = resolver.title(outcome)
        if (Option.isNone(title)) {
          yield* Effect.logDebug("session title not found").pipe(Effect.annotateLogs({ harness, result: outcome._tag }))
        } else {
          yield* remember(key, title.value)
        }
        return title
      })
    }

    const cache = yield* Cache.makeWith(resolve, {
      capacity: 1024,
      timeToLive: (exit) => Exit.isSuccess(exit) && Option.isSome(exit.value) ? found : missing
    })

    const lookup = (sessions: ReadonlyArray<Session.Target>) =>
      Effect.forEach(
        sessions,
        (session) =>
          Cache.get(cache, keyOf(session)).pipe(
            Effect.map((title) => Option.map(Option.orElse(title, () => lastTitle(session)), named(session)))
          ),
        { concurrency: "unbounded" }
      ).pipe(Effect.map((titles) => titles.flatMap(Option.toArray)))

    const titles = (sessions: ReadonlyArray<Session.Target>) =>
      Effect.gen(function*() {
        const known: Array<Session.SessionTitle> = []
        const unknown: Array<Session.Target> = []
        for (const session of sessions) {
          const entry = yield* Cache.getSuccess(cache, keyOf(session))
          if (Option.isNone(entry)) unknown.push(session)
          const title = Option.orElse(Option.flatten(entry), () => lastTitle(session))
          if (Option.isSome(title)) known.push(named(session)(title.value))
        }
        if (unknown.length > 0) yield* Effect.forkIn(lookup(unknown), scope)
        return known
      })

    return { titles, lookup }
  })

/** {@link make} as the daemon's {@link SessionTitles.SessionTitles}: the panel's polls never wait on a harness CLI. */
export const layer = (
  options: Omit<Options, "memory"> & { readonly file?: string } = {}
): Layer.Layer<SessionTitles.SessionTitles, never, ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path> =>
  Layer.effect(
    SessionTitles.SessionTitles,
    Effect.gen(function*() {
      const memory = options.file === undefined ? undefined : yield* fileMemory(options.file)
      const { titles } = yield* make(memory === undefined ? options : { ...options, memory })
      return { titles }
    })
  )
