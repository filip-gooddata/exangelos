import { Cache, Duration, Effect, Exit, Layer, Option } from "effect"
import { ChildProcessSpawner } from "effect/process"
import { SessionTitles } from "@exangelos/application"
import type { Session } from "@exangelos/domain"
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

export interface Options {
  /** How long one lookup may run. Default 5 seconds. */
  readonly limit?: Duration.Input
  /** How long a found title is kept. Default 10 minutes, so a renamed thread shows its new title. */
  readonly found?: Duration.Input
  /** How long a session without a title is kept. Default 2 minutes, so a broken CLI isn't run on every poll. */
  readonly missing?: Duration.Input
  /** How many lookups run at once. Default 4. */
  readonly concurrency?: number
  /** Where the harness CLIs are looked up, read at each lookup. Default the daemon's environment and file system. */
  readonly lookup?: () => Executable.Lookup
}

const separator = "\u0000"

/**
 * Titles found through each harness's CLI and kept in the daemon's memory. Concurrent lookups of
 * one session share a run; a session the CLI can't name is left out.
 */
export const layer = (
  options: Options = {}
): Layer.Layer<SessionTitles.SessionTitles, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Layer.effect(SessionTitles.SessionTitles, Effect.gen(function*() {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const lookup = options.lookup ?? Executable.system
    const limit = Duration.fromInputUnsafe(options.limit ?? Duration.seconds(5))
    const found = Duration.fromInputUnsafe(options.found ?? Duration.minutes(10))
    const missing = Duration.fromInputUnsafe(options.missing ?? Duration.minutes(2))

    const resolve = (key: string): Effect.Effect<Option.Option<string>> => {
      const [harness = "", sessionId = ""] = key.split(separator)
      const resolver = resolvers[harness as Session.Harness]
      if (resolver === undefined) return Effect.succeedNone
      return Effect.gen(function*() {
        const located = Executable.locate(resolver.invocation(sessionId), lookup())
        const outcome = "_tag" in located ? located : yield* run(spawner, located, limit)
        const title = resolver.title(outcome)
        if (Option.isNone(title)) {
          yield* Effect.logDebug("session title not found").pipe(Effect.annotateLogs({ harness, result: outcome._tag }))
        }
        return title
      })
    }

    const cache = yield* Cache.makeWith(resolve, {
      capacity: 1024,
      timeToLive: (exit) => Exit.isSuccess(exit) && Option.isSome(exit.value) ? found : missing
    })

    return {
      titles: (sessions) =>
        Effect.forEach(
          sessions,
          (session) =>
            Cache.get(cache, `${session.harness}${separator}${session.sessionId}`).pipe(
              Effect.map(Option.map((title) => ({ harness: session.harness, sessionId: session.sessionId, title })))
            ),
          { concurrency: options.concurrency ?? 4 }
        ).pipe(Effect.map((titles) => titles.flatMap(Option.toArray)))
    }
  }))
