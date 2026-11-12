import { Clock, Duration, Effect, Option, Stream } from "effect"
import * as Cursor from "./Cursor.ts"
import { type Emitted, type EndReason, type Filters, type Memory, step } from "./Diff.ts"
import {
  type Connection,
  type Fetched,
  GitHub,
  type NotFound,
  type Quota,
  type Since,
  type Unauthorized,
  type Unavailable
} from "./GitHub.ts"
import type { PullRequestRef } from "./PullRequestRef.ts"

/**
 * One poll a minute. A poll is one GraphQL query worth one point of the
 * 5,000 an hour a token gets, so fifty watched pull requests use 3,000 and
 * leave room for the person's own use of the token.
 */
export const interval = Duration.minutes(1)

/** Attempts at a poll GitHub cannot answer before the watch fails and the daemon retries it. */
const attempts = 4

const transientBackoff = (failures: number) => Duration.seconds(15 * 2 ** failures)

/** Waits at least as long as GitHub asks, doubling from a minute on each refusal in a row, up to 15 minutes. */
const limitBackoff = (refusals: number, asked: Duration.Duration) =>
  refusals === 0 ? asked : Duration.max(asked, Duration.min(Duration.minutes(2 ** refusals), Duration.minutes(15)))

export interface Polled {
  readonly events: ReadonlyArray<Emitted>
  readonly cursor: string
  readonly end: EndReason | null
}

const since = (memory: Memory | undefined): Since | undefined =>
  memory === undefined ? undefined : { reviews: memory.reviews.at, comments: memory.comments.at, threads: memory.threads.at }

const nextDelay = (quota: Option.Option<Quota>, now: number) =>
  Option.match(quota, {
    onNone: () => interval,
    onSome: ({ remaining, resetAt }) =>
      remaining > 0 ? interval : Duration.max(interval, Duration.millis(resetAt - now))
  })

/**
 * Polls one pull request from the given cursor until it is merged or closed.
 * Rate limits are waited out, other failures retried a few times, and a
 * refused token or a missing pull request fails the stream.
 */
export const watch = (
  connection: Connection,
  ref: PullRequestRef,
  filters: Filters,
  cursor: string | undefined
): Stream.Stream<Polled, Unauthorized | NotFound | Unavailable, GitHub> =>
  Stream.unwrap(Effect.gen(function*() {
    const github = yield* GitHub

    const fetch = (
      memory: Memory | undefined,
      failures: number,
      refusals: number
    ): Effect.Effect<Fetched, Unauthorized | NotFound | Unavailable> =>
      github.pullRequest(connection, ref, since(memory)).pipe(
        Effect.catchTags({
          RateLimited: ({ retryAfter }) =>
            Effect.sleep(limitBackoff(refusals, retryAfter)).pipe(Effect.andThen(fetch(memory, failures, refusals + 1))),
          Unavailable: (error) =>
            failures + 1 >= attempts
              ? Effect.fail(error)
              : Effect.sleep(transientBackoff(failures)).pipe(Effect.andThen(fetch(memory, failures + 1, refusals)))
        })
      )

    return Stream.paginate(
      { memory: Cursor.decode(cursor), delay: Duration.zero },
      ({ delay, memory }) =>
        Effect.gen(function*() {
          yield* Effect.sleep(delay)
          const { quota, snapshot } = yield* fetch(memory, 0, 0)
          const now = yield* Clock.currentTimeMillis
          const result = step(memory, snapshot, filters, new Date(now).toISOString())
          const polled: Polled = { events: result.events, cursor: Cursor.encode(result.memory), end: result.end }
          const next = result.end === null
            ? Option.some({ memory: result.memory, delay: nextDelay(quota, now) })
            : Option.none()
          return [[polled], next] as const
        })
    )
  }))
