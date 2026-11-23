import { Context, Schema } from "effect"
import type { Effect } from "effect"

export const StartMethod = Schema.Literals(["homebrew", "launch-agent", "systemd-user", "foreground"])
export type StartMethod = typeof StartMethod.Type

export const Status = Schema.Struct({
  method: StartMethod,
  installed: Schema.Boolean,
  running: Schema.Boolean
})
export type Status = typeof Status.Type

export class ServiceFailed extends Schema.TaggedError<ServiceFailed>()("ServiceFailed", {
  method: StartMethod,
  reason: Schema.String
}) {}

export class ServiceManager extends Context.Service<ServiceManager, {
  /**
   * How this install starts the daemon, known without asking the service manager; fails only when
   * the service settings could not be read.
   */
  readonly startMethod: Effect.Effect<StartMethod, ServiceFailed>
  /**
   * The start method of this install: the Homebrew service for a formula install, otherwise the
   * own LaunchAgent or systemd user unit; foreground for a daemon no service started.
   */
  readonly status: Effect.Effect<Status, ServiceFailed>
  /** Writes the own LaunchAgent or systemd user unit. A Homebrew install needs none. */
  readonly install: Effect.Effect<void, ServiceFailed>
  readonly start: Effect.Effect<void, ServiceFailed>
}>()("@exangelos/application/ServiceManager") {}
