import { Array as Arr, DateTime, Duration, Option, Result } from "effect"
import type { Parameters } from "./Catalogue.ts"
import type { EventType, ConnectorName, SubscriptionId } from "./Ids.ts"
import type { Limits } from "./Limits.ts"
import type { Connector, ObservationFailure } from "./Connector.ts"
import * as ConnectorRules from "./ConnectorRules.ts"
import { BacklogOverLimit, NotAllowed } from "./Refusal.ts"
import { type Actor, sameSession, type Target } from "./Session.ts"
import type { EndReason, PauseReason, State, Subscription } from "./Subscription.ts"
import type { Why } from "./Wake.ts"

export interface Step {
  readonly subscription: Subscription
  readonly wake: Option.Option<Why>
}

export interface NewSubscription {
  readonly id: SubscriptionId
  readonly connector: ConnectorName
  readonly parameters: Parameters
  readonly subject: string
  readonly label: string
  readonly intent: string
  readonly wakeTarget: Option.Option<Target>
  readonly eventTypes?: ReadonlyArray<EventType>
  readonly endAt?: DateTime.Utc
  readonly maxEvents?: number
  readonly once?: boolean
  readonly eventAlerts?: boolean
}

export const create = (input: NewSubscription, now: DateTime.Utc, limits: Limits): Subscription => {
  const lifetimeEnd = DateTime.addDuration(now, limits.lifetime)
  const expiresAt = input.endAt === undefined ? lifetimeEnd : DateTime.min(input.endAt, lifetimeEnd)
  const maxEvents = input.once === true ? 1 : input.maxEvents
  const eventTypes = input.eventTypes ?? []
  return {
    id: input.id,
    connector: input.connector,
    parameters: input.parameters,
    subject: input.subject,
    label: input.label,
    intent: input.intent,
    ...(Arr.isReadonlyArrayNonEmpty(eventTypes) ? { eventTypes } : {}),
    ...Option.match(input.wakeTarget, { onNone: () => ({}), onSome: (wakeTarget) => ({ wakeTarget }) }),
    createdAt: now,
    expiresAt,
    ...(maxEvents === undefined ? {} : { maxEvents }),
    state: { _tag: "Active" },
    stateSince: now,
    lastNumber: 0,
    ackedThrough: 0,
    eventAlerts: input.eventAlerts ?? false
  }
}

export const pendingCount = (subscription: Subscription): number => subscription.lastNumber - subscription.ackedThrough

export const isOpen = (subscription: Subscription): boolean =>
  subscription.state._tag === "Active" || subscription.state._tag === "Paused" || subscription.state._tag === "Expired"

export const isWatched = (subscription: Subscription, connector: Connector): boolean =>
  subscription.state._tag === "Active" && ConnectorRules.isAvailable(connector)

export const isSuspendedWhen = (subscription: Subscription, available: boolean): boolean =>
  subscription.state._tag === "Active" && !available

export const isSuspended = (subscription: Subscription, connector: Connector): boolean =>
  isSuspendedWhen(subscription, ConnectorRules.isAvailable(connector))

export const isOwnSession = (subscription: Subscription, actor: Actor): boolean =>
  actor._tag === "Session" && subscription.wakeTarget !== undefined && sameSession(actor.session, subscription.wakeTarget)

const enter = (subscription: Subscription, state: State, now: DateTime.Utc): Subscription => ({
  ...subscription,
  state,
  stateSince: now
})

const overBacklog = (
  subscription: Subscription,
  oldestPending: Option.Option<DateTime.Utc>,
  now: DateTime.Utc,
  limits: Limits
): Option.Option<PauseReason> => {
  if (pendingCount(subscription) >= limits.backlogCount) {
    return Option.some({ _tag: "BacklogCount", limit: limits.backlogCount })
  }
  return Option.filter(oldestPending, (oldest) =>
    pendingCount(subscription) > 0 &&
    DateTime.isLessThanOrEqualTo(DateTime.addDuration(oldest, limits.backlogAge), now)
  ).pipe(Option.as({ _tag: "BacklogAge", limit: limits.backlogAge } as const))
}

export const backlog = (
  subscription: Subscription,
  oldestPending: Option.Option<DateTime.Utc>,
  now: DateTime.Utc,
  limits: Limits
): Option.Option<Step> => {
  if (subscription.state._tag !== "Active") return Option.none()
  return Option.map(overBacklog(subscription, oldestPending, now, limits), (reason) => ({
    subscription: enter(subscription, { _tag: "Paused", reason }, now),
    wake: Option.some({ _tag: "Paused", reason })
  }))
}

const notAllowed = (action: NotAllowed["action"], subscription: Subscription) =>
  Result.fail(new NotAllowed({ action, state: subscription.state._tag }))

export const pause = (subscription: Subscription, actor: Actor, now: DateTime.Utc): Result.Result<Step, NotAllowed> => {
  if (subscription.state._tag !== "Active") return notAllowed("pause", subscription)
  const reason: PauseReason = { _tag: "Actor", actor }
  return Result.succeed({
    subscription: enter(subscription, { _tag: "Paused", reason }, now),
    wake: isOwnSession(subscription, actor) ? Option.none() : Option.some({ _tag: "Paused", reason })
  })
}

export const resume = (
  subscription: Subscription,
  oldestPending: Option.Option<DateTime.Utc>,
  now: DateTime.Utc,
  limits: Limits
): Result.Result<Step, NotAllowed | BacklogOverLimit> => {
  if (subscription.state._tag !== "Paused" && subscription.state._tag !== "Expired") {
    return notAllowed("resume", subscription)
  }
  if (Option.isSome(overBacklog(subscription, oldestPending, now, limits))) {
    return Result.fail(new BacklogOverLimit({ pending: pendingCount(subscription), through: subscription.lastNumber }))
  }
  return Result.succeed({
    subscription: {
      ...enter(subscription, { _tag: "Active" }, now),
      expiresAt: DateTime.addDuration(now, limits.lifetime)
    },
    wake: Option.none()
  })
}

export const expire = (subscription: Subscription, now: DateTime.Utc): Option.Option<Step> => {
  const state = subscription.state._tag
  if ((state !== "Active" && state !== "Paused") || DateTime.isLessThan(now, subscription.expiresAt)) {
    return Option.none()
  }
  return Option.some({
    subscription: enter(subscription, { _tag: "Expired" }, now),
    wake: state === "Active" ? Option.some({ _tag: "Expired" }) : Option.none()
  })
}

export const end = (subscription: Subscription, reason: EndReason, now: DateTime.Utc): Result.Result<Step, NotAllowed> => {
  if (subscription.state._tag !== "Active") return notAllowed("end", subscription)
  return Result.succeed({
    subscription: enter(subscription, { _tag: "Ended", reason }, now),
    wake: Option.some({ _tag: "Ended", reason })
  })
}

export const cancel = (subscription: Subscription, actor: Actor, now: DateTime.Utc): Result.Result<Step, NotAllowed> => {
  if (!isOpen(subscription)) return notAllowed("cancel", subscription)
  return Result.succeed({
    subscription: enter(subscription, { _tag: "Cancelled", actor }, now),
    wake: isOwnSession(subscription, actor) ? Option.none() : Option.some({ _tag: "Cancelled", actor })
  })
}

export const suspensionWakeWhen = (
  subscription: Subscription,
  unavailable: Option.Option<{ readonly since: DateTime.Utc; readonly problem: string }>,
  lastSuspensionWake: Option.Option<DateTime.Utc>,
  now: DateTime.Utc,
  limits: Limits
): Option.Option<Why> => {
  if (Option.isNone(unavailable) || !isSuspendedWhen(subscription, false)) return Option.none()
  const { since, problem } = unavailable.value
  if (DateTime.isLessThan(now, DateTime.addDuration(since, limits.unavailableBeforeWake))) return Option.none()
  if (Option.exists(lastSuspensionWake, (woken) => DateTime.isGreaterThanOrEqualTo(woken, since))) return Option.none()
  return Option.some({ _tag: "Suspended", since, problem } as const)
}

export const suspensionWake = (
  subscription: Subscription,
  connector: Connector,
  lastSuspensionWake: Option.Option<DateTime.Utc>,
  now: DateTime.Utc,
  limits: Limits
): Option.Option<Why> => {
  const since = connector.unavailableSince
  const unavailable = since === undefined || ConnectorRules.isAvailable(connector)
    ? Option.none()
    : Option.map(ConnectorRules.problem(connector), (problem) => ({ since, problem }))
  return suspensionWakeWhen(subscription, unavailable, lastSuspensionWake, now, limits)
}

/** How long a source must keep failing before the subscription's session hears of it. */
export const failingBeforeWake = Duration.minutes(5)

/** The least time between two failing wakes of one subscription, so a flapping source cannot wake on every cycle. */
export const failingWakeCooldown = Duration.hours(1)

/** What the subscription's stored wakes say about its failing wakes. */
export interface FailingHistory {
  /** A failing wake was sent or queued and no recovered wake has followed it, even before a daemon restart. */
  readonly unresolved: boolean
  readonly lastFailingWake: Option.Option<DateTime.Utc>
}

/**
 * The failing wake an active subscription owes: once its source has failed for `failingBeforeWake`,
 * not while an earlier failing wake is unresolved, and not within `failingWakeCooldown` of the last one.
 */
export const failingWake = (
  subscription: Subscription,
  failure: ObservationFailure,
  history: FailingHistory,
  now: DateTime.Utc
): Option.Option<Why> => {
  if (subscription.state._tag !== "Active" || history.unresolved) return Option.none()
  if (DateTime.isLessThan(now, DateTime.addDuration(failure.since, failingBeforeWake))) return Option.none()
  if (Option.exists(history.lastFailingWake, (woken) => DateTime.isLessThan(now, DateTime.addDuration(woken, failingWakeCooldown)))) {
    return Option.none()
  }
  return Option.some({ _tag: "Failing", ...failure } as const)
}
