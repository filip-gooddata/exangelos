import { Cause, Context, Duration, Effect, Schedule, Schema } from "effect"
import { RpcClientError } from "effect/rpc"

/** How long a lost daemon gets to answer again before {@link persist} fails with {@link DaemonUnreachable}. */
export const Patience = Context.Reference<Duration.Duration>("@exangelos/daemon-client/Reconnect/Patience", {
  defaultValue: () => Duration.minutes(5)
})

export class DaemonUnreachable extends Schema.TaggedError<DaemonUnreachable>()("DaemonUnreachable", {
  waited: Schema.String,
  reason: Schema.String
}) {}

/** A lost connection that {@link persist} retries, for a failure that is not an RpcClientError itself. */
export const lostWith = (message: string): RpcClientError.RpcClientError =>
  new RpcClientError.RpcClientError({ reason: new RpcClientError.RpcClientDefect({ message, cause: undefined }) })

const daemonStopped = lostWith("the daemon stopped before it answered")

/**
 * Turns a call the daemon interrupted, as it does to every call in flight when it stops, into a lost connection that
 * {@link persist} retries. Interrupting the calling fiber itself still interrupts it.
 */
export const daemonInterruptsAsLoss = <A, E, R>(call: Effect.Effect<A, E, R>): Effect.Effect<A, E | RpcClientError.RpcClientError, R> =>
  call.pipe(Effect.catchCauseIf(Cause.hasInterruptsOnly, () => Effect.fail(daemonStopped)))

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
      Effect.suspend(() => {
        let reason = lost.message
        return Effect.logDebug("daemon connection lost, waiting for it to answer").pipe(
          Effect.annotateLogs({ reason }),
          Effect.andThen(Effect.sleep("250 millis")),
          Effect.andThen(
            alive.pipe(
              Effect.timeout("10 seconds"),
              Effect.tapError((error) => Effect.sync(() => (reason = reasonOf(error)))),
              Effect.retry(Schedule.min([Schedule.exponential("250 millis"), Schedule.spaced("5 seconds")]))
            )
          ),
          Effect.timeoutOrElse({
            duration: patience,
            orElse: () => Effect.fail(new DaemonUnreachable({ waited: Duration.format(patience), reason }))
          })
        )
      })
    const attempt: Effect.Effect<A, Exclude<E, RpcClientError.RpcClientError> | DaemonUnreachable, R | R2> = call.pipe(
      Effect.catchIf(
        isConnectionError as (error: E) => error is E & RpcClientError.RpcClientError,
        (lost) => Effect.andThen(recovered(lost), Effect.suspend(() => attempt))
      )
    ) as never
    return yield* attempt
  })
