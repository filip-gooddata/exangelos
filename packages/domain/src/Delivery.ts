import { DateTime, Duration, Effect, Option, Schedule } from "effect"
import type { Event } from "./Event.ts"
import type { WakeId } from "./Ids.ts"
import * as Lifecycle from "./Lifecycle.ts"
import * as ConnectorRules from "./ConnectorRules.ts"
import type { Limits } from "./Limits.ts"
import type { Connector } from "./Connector.ts"
import type { Subscription } from "./Subscription.ts"
import type { Wake, WakeContent, WakeReason, Why } from "./Wake.ts"

export const retryBase = Duration.seconds(5)

export const retryDelay = (attempt: number, limits: Limits): Duration.Duration =>
  Duration.min(Duration.times(retryBase, Math.pow(2, Math.max(0, attempt - 1))), limits.maxRetryDelay)

export const retrySchedule = (limits: Limits): Schedule.Schedule<Duration.Duration> =>
  Schedule.exponential(retryBase).pipe(
    Schedule.modifyDelay(({ attempt }) => Effect.succeed(retryDelay(attempt, limits)))
  )

export const reasonOf = (why: Why): WakeReason => {
  switch (why._tag) {
    case "Events":
      return "events"
    case "Paused":
      return "paused"
    case "Expired":
      return "expired"
    case "Ended":
      return "ended"
    case "Cancelled":
      return "cancelled"
    case "Suspended":
      return "suspended"
  }
}

export const isUndelivered = (wake: Wake): boolean => wake.state === "waiting" || wake.state === "sending"

export interface Request {
  readonly id: WakeId
  readonly why: Why
  readonly subscription: Subscription
  readonly now: DateTime.Utc
}

export const plan = (current: Option.Option<Wake>, request: Request, limits: Limits): ReadonlyArray<Wake> => {
  const { id, now, subscription, why } = request
  const through = subscription.lastNumber
  const open = Option.filter(current, isUndelivered)
  const inWindow = Option.filter(open, (wake) =>
    wake.reason === "events" && wake.state === "waiting" && wake.attempts.count === 0
  )
  if (why._tag === "Events" && Option.isSome(inWindow)) {
    return [{ ...inWindow.value, through }]
  }
  const opensWindow = why._tag === "Events" && Option.isNone(open) && Lifecycle.pendingCount(subscription) === 1
  const next: Wake = {
    id,
    subscription: subscription.id,
    reason: reasonOf(why),
    through,
    state: "waiting",
    attempts: { count: 0, nextAttemptAt: opensWindow ? DateTime.addDuration(now, limits.wakeWindow) : now },
    createdAt: now
  }
  return Option.match(open, {
    onNone: () => [next],
    onSome: (replaced) => [{ ...replaced, state: "replaced" as const }, next]
  })
}

export const retry = (wake: Wake, error: string, now: DateTime.Utc, limits: Limits): Wake => {
  const count = wake.attempts.count + 1
  return {
    ...wake,
    state: "waiting",
    attempts: { count, lastError: error, nextAttemptAt: DateTime.addDuration(now, retryDelay(count, limits)) }
  }
}

export const hasSomethingToSay = (wake: Wake, subscription: Subscription, connector: Connector): boolean =>
  hasSomethingToSayWhen(wake, subscription, ConnectorRules.isAvailable(connector))

export const hasSomethingToSayWhen = (wake: Wake, subscription: Subscription, available: boolean): boolean => {
  switch (wake.reason) {
    case "events":
      return subscription.ackedThrough < wake.through
    case "paused":
      return subscription.state._tag === "Paused" || subscription.state._tag === "Expired"
    case "expired":
      return subscription.state._tag === "Expired"
    case "suspended":
      return Lifecycle.isSuspendedWhen(subscription, available)
    case "ended":
    case "cancelled":
      return true
  }
}

export const content = (subscription: Subscription, why: Why, events: ReadonlyArray<Event>): WakeContent => ({
  subscription: subscription.id,
  connector: subscription.connector,
  subject: subscription.subject,
  why,
  pending: events
    .filter((event) => event.number > subscription.ackedThrough)
    .toSorted((a, b) => a.number - b.number)
    .map(({ number, summary, type }) => ({ number, type, summary }))
})

const stateWhy = (subscription: Subscription): Option.Option<Why> => {
  const state = subscription.state
  switch (state._tag) {
    case "Active":
      return Option.none()
    case "Paused":
      return Option.some({ _tag: "Paused", reason: state.reason })
    case "Expired":
      return Option.some({ _tag: "Expired" })
    case "Ended":
      return Option.some({ _tag: "Ended", reason: state.reason })
    case "Cancelled":
      return Option.some({ _tag: "Cancelled", actor: state.actor })
  }
}

export const waitContent = (
  subscription: Subscription,
  pending: ReadonlyArray<Event>,
  suspension: Option.Option<Why>
): Option.Option<WakeContent> => {
  const events: Option.Option<Why> = Lifecycle.pendingCount(subscription) > 0
    ? Option.some({ _tag: "Events" })
    : Option.none()
  return stateWhy(subscription).pipe(
    Option.orElse(() => events),
    Option.orElse(() => suspension),
    Option.map((why) => content(subscription, why, pending))
  )
}
