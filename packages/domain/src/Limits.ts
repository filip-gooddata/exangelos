import { Duration, Schema } from "effect"

export const Limits = Schema.Struct({
  wakeWindow: Schema.DurationFromMillis,
  backlogCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  backlogAge: Schema.DurationFromMillis,
  lifetime: Schema.DurationFromMillis,
  unavailableBeforeWake: Schema.DurationFromMillis,
  maxRetryDelay: Schema.DurationFromMillis,
  retention: Schema.DurationFromMillis
})
export type Limits = typeof Limits.Type

export const defaults: Limits = {
  wakeWindow: Duration.seconds(5),
  backlogCount: 20,
  backlogAge: Duration.hours(24),
  lifetime: Duration.days(7),
  unavailableBeforeWake: Duration.hours(1),
  maxRetryDelay: Duration.minutes(10),
  retention: Duration.days(30)
}
