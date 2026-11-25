import { Clock, Context, Duration, Effect, Result, Schema } from "effect"
import type { RpcClientError } from "effect/rpc"

/** How long a call keeps retrying while the daemon does not answer, before it fails with {@link DaemonUnreachable}. */
export const Patience = Context.Reference<Duration.Duration>("@exangelos/cli/Reconnect/Patience", {
  defaultValue: () => Duration.minutes(5)
})

export class DaemonUnreachable extends Schema.TaggedError<DaemonUnreachable>()("DaemonUnreachable", {
  waited: Schema.String,
  reason: Schema.String
}) {}

/** A call that held this long reached a live daemon, so its failure starts a new outage. */
const held = Duration.seconds(5)
const firstDelay = Duration.millis(250)
const longestDelay = Duration.seconds(5)

const isConnectionError = (error: unknown): error is RpcClientError.RpcClientError =>
  typeof error === "object" && error !== null && "_tag" in error && error._tag === "RpcClientError"

/**
 * Runs `call` again whenever the daemon connection fails (a restart, an upgrade), with backoff up to
 * {@link longestDelay}. Fails with {@link DaemonUnreachable} once the daemon has not answered for {@link Patience}.
 */
export const persist = <A, E, R>(
  call: Effect.Effect<A, E, R>
): Effect.Effect<A, Exclude<E, RpcClientError.RpcClientError> | DaemonUnreachable, R> =>
  Effect.gen(function*() {
    const patience = yield* Patience
    let outageSince: number | undefined
    let delay = firstDelay
    while (true) {
      const started = yield* Clock.currentTimeMillis
      const result = yield* Effect.result(call)
      if (Result.isSuccess(result)) return result.success
      const error = result.failure
      if (!isConnectionError(error)) return yield* Effect.fail(error as Exclude<E, RpcClientError.RpcClientError>)
      const now = yield* Clock.currentTimeMillis
      if (outageSince === undefined || now - started >= Duration.toMillis(held)) {
        outageSince = now
        delay = firstDelay
      }
      if (now - outageSince >= Duration.toMillis(patience)) {
        return yield* new DaemonUnreachable({ waited: Duration.format(patience), reason: error.message })
      }
      yield* Effect.logDebug("daemon connection lost, retrying").pipe(
        Effect.annotateLogs({ reason: error.message, retryIn: Duration.format(delay) })
      )
      yield* Effect.sleep(delay)
      delay = Duration.min(Duration.times(delay, 2), longestDelay)
    }
  })
