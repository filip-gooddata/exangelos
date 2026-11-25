import { Context, Duration, Effect, Schedule, Schema } from "effect"
import type { RpcClientError } from "effect/rpc"

/** How long a lost daemon gets to answer again before {@link persist} fails with {@link DaemonUnreachable}. */
export const Patience = Context.Reference<Duration.Duration>("@exangelos/cli/Reconnect/Patience", {
  defaultValue: () => Duration.minutes(5)
})

export class DaemonUnreachable extends Schema.TaggedError<DaemonUnreachable>()("DaemonUnreachable", {
  waited: Schema.String,
  reason: Schema.String
}) {}

const isConnectionError = (error: unknown): error is RpcClientError.RpcClientError =>
  typeof error === "object" && error !== null && "_tag" in error && error._tag === "RpcClientError"

const reasonOf = (error: unknown): string => error instanceof Error ? error.message : String(error)

/**
 * Runs `call`, and after a connection failure (a daemon restart or upgrade) retries `alive` with backoff until the daemon
 * answers, then runs `call` again. Fails with {@link DaemonUnreachable} when `alive` has not succeeded within {@link Patience}.
 */
export const persist = <A, E, R, R2>(
  call: Effect.Effect<A, E, R>,
  alive: Effect.Effect<unknown, unknown, R2>
): Effect.Effect<A, Exclude<E, RpcClientError.RpcClientError> | DaemonUnreachable, R | R2> =>
  Effect.gen(function*() {
    const patience = yield* Patience
    const recovered = (lost: RpcClientError.RpcClientError) =>
      Effect.logDebug("daemon connection lost, waiting for it to answer").pipe(
        Effect.annotateLogs({ reason: lost.message }),
        Effect.andThen(
          alive.pipe(
            Effect.timeout(Duration.min(Duration.seconds(10), patience)),
            Effect.retryOrElse(
              Schedule.min([Schedule.exponential("250 millis"), Schedule.spaced("5 seconds")]).pipe(
                Schedule.upTo({ duration: patience })
              ),
              (error) => Effect.fail(new DaemonUnreachable({ waited: Duration.format(patience), reason: reasonOf(error) }))
            )
          )
        )
      )
    const attempt: Effect.Effect<A, Exclude<E, RpcClientError.RpcClientError> | DaemonUnreachable, R | R2> = call.pipe(
      Effect.catchIf(
        isConnectionError as (error: E) => error is E & RpcClientError.RpcClientError,
        (lost) => Effect.andThen(recovered(lost), Effect.suspend(() => attempt))
      )
    ) as never
    return yield* attempt
  })
