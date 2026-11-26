import { Clock, Duration, Effect, Option, Stream } from "effect"
import type { Transport } from "@exangelos/connector-github-pr"
import * as Cursor from "./Cursor.ts"
import { type Filters, type Memory, type Site, step } from "./Diff.ts"
import type { Emitted } from "./Events.ts"
import { type Connection, type Etags, type Fetched, GitHub, type Quota, type TooManyRefs } from "./GitHub.ts"
import type { Repository } from "./Repository.ts"

export const interval = Duration.minutes(1)

export type Failure = Transport.Unauthorized | Transport.NotFound | Transport.Unavailable | Transport.Forbidden | TooManyRefs

const attempts = 4

const transientBackoff = (failures: number) => Duration.seconds(15 * 2 ** failures)

const limitBackoff = (refusals: number, asked: Duration.Duration) =>
  refusals === 0 ? asked : Duration.max(asked, Duration.min(Duration.minutes(2 ** refusals), Duration.minutes(15)))

export interface Polled {
  readonly events: ReadonlyArray<Emitted>
  readonly cursor: string
}

const nextDelay = (quota: Option.Option<Quota>, now: number) =>
  Option.match(quota, {
    onNone: () => interval,
    onSome: ({ remaining, resetAt }) =>
      remaining > 0 ? interval : Duration.max(interval, Duration.millis(resetAt - now))
  })

interface State {
  readonly memory: Memory | undefined
  readonly etags: Etags
  readonly delay: Duration.Duration
}

export const watch = (
  connection: Connection,
  repository: Repository,
  filters: Filters,
  site: Site,
  cursor: string | undefined
): Stream.Stream<Polled, Failure, GitHub> =>
  Stream.unwrap(Effect.gen(function*() {
    const github = yield* GitHub

    const fetch = (
      etags: Etags,
      failures: number,
      refusals: number
    ): Effect.Effect<Fetched, Failure> =>
      github.snapshot(connection, repository, filters, etags).pipe(
        Effect.catchTags({
          RateLimited: ({ retryAfter }) =>
            Effect.sleep(limitBackoff(refusals, retryAfter)).pipe(Effect.andThen(fetch(etags, failures, refusals + 1))),
          Unavailable: (error) =>
            failures + 1 >= attempts
              ? Effect.fail(error)
              : Effect.sleep(transientBackoff(failures)).pipe(Effect.andThen(fetch(etags, failures + 1, refusals)))
        })
      )

    const first: State = { memory: Cursor.decode(cursor), etags: new Map(), delay: Duration.zero }
    return Stream.paginate(first, ({ delay, etags, memory }) =>
      Effect.gen(function*() {
        yield* Effect.sleep(delay)
        const fetched = yield* fetch(memory === undefined ? new Map() : etags, 0, 0)
        const now = yield* Clock.currentTimeMillis
        const observed = Option.getOrElse(fetched.observedAt, () => now)
        const result = step(memory, fetched.snapshot, filters, site, new Date(observed).toISOString())
        const polled: Polled = { events: result.events, cursor: Cursor.encode(result.memory) }
        const next: State = { memory: result.memory, etags: fetched.etags, delay: nextDelay(fetched.quota, now) }
        return [[polled], Option.some(next)] as const
      }))
  }))
