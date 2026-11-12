import { Array as Arr, DateTime, Option, Result } from "effect"
import type { Parameters } from "./Catalogue.ts"
import type { EventType, PluginName, SubscriptionId } from "./Ids.ts"
import * as Lifecycle from "./Lifecycle.ts"
import type { Limits } from "./Limits.ts"
import type { Plugin } from "./Plugin.ts"
import * as PluginRules from "./PluginRules.ts"
import { IntentRequired, NoWakeTarget, PluginUnavailable, SimilarSubscriptions, SubjectChanged } from "./Refusal.ts"
import { sameSession, type Session } from "./Session.ts"
import type { Subscription } from "./Subscription.ts"

export const checkIntent = (intent: string): Result.Result<string, IntentRequired> => {
  const line = intent.trim()
  if (line.length === 0) return Result.fail(new IntentRequired({ message: "Say in one line why you subscribe." }))
  if (/[\r\n]/.test(line)) return Result.fail(new IntentRequired({ message: "The intent must be one line." }))
  return Result.succeed(line)
}

export const check = (plugin: Plugin, intent: string): Result.Result<string, IntentRequired | PluginUnavailable> =>
  Option.match(PluginRules.problem(plugin), {
    onNone: () => checkIntent(intent),
    onSome: (problem) => Result.fail(new PluginUnavailable({ plugin: plugin.name, problem }))
  })

export type TargetFlag =
  | { readonly _tag: "Session"; readonly session: Session }
  | { readonly _tag: "PullOnly" }

export const wakeTarget = (
  detected: ReadonlyArray<Session>,
  flag: Option.Option<TargetFlag>
): Result.Result<Option.Option<Session>, NoWakeTarget> => {
  if (Option.isSome(flag)) {
    return Result.succeed(flag.value._tag === "Session" ? Option.some(flag.value.session) : Option.none())
  }
  const caller = detected.find((session) => session.harness === "t3") ?? detected[0]
  return caller === undefined ? Result.fail(new NoWakeTarget()) : Result.succeed(Option.some(caller))
}

export interface Candidate {
  readonly plugin: PluginName
  readonly subject: string
  readonly wakeTarget: Option.Option<Session>
}

const sameTarget = (a: Option.Option<Session>, b: Session | undefined): boolean =>
  Option.match(a, { onNone: () => b === undefined, onSome: (session) => b !== undefined && sameSession(session, b) })

export const similar = (
  subscriptions: ReadonlyArray<Subscription>,
  candidate: Candidate,
  acknowledged: ReadonlyArray<SubscriptionId>
): Result.Result<void, SimilarSubscriptions> => {
  const matches = subscriptions.filter((subscription) =>
    Lifecycle.isOpen(subscription) &&
    subscription.plugin === candidate.plugin &&
    subscription.subject === candidate.subject &&
    sameTarget(candidate.wakeTarget, subscription.wakeTarget)
  )
  const [first, ...rest] = matches
  if (first === undefined || matches.every((match) => acknowledged.includes(match.id))) return Result.void
  const listed = (subscription: Subscription) => ({ id: subscription.id, parameters: subscription.parameters })
  return Result.fail(new SimilarSubscriptions({ matches: [listed(first), ...rest.map(listed)] }))
}

export interface Patch {
  readonly eventTypes?: ReadonlyArray<EventType>
  readonly maxEvents?: number
  readonly until?: DateTime.Utc
  readonly intent?: string
  readonly parameters?: Parameters
  readonly label?: string
}

export interface UpdateContext {
  readonly reportedSubject: string
  readonly lastStart: DateTime.Utc
  readonly now: DateTime.Utc
  readonly limits: Limits
}

export const update = (
  subscription: Subscription,
  patch: Patch,
  context: UpdateContext
): Result.Result<Lifecycle.Step, SubjectChanged | IntentRequired> => {
  if (context.reportedSubject !== subscription.subject) {
    return Result.fail(new SubjectChanged({ subject: subscription.subject, reported: context.reportedSubject }))
  }
  const intent = patch.intent === undefined ? Result.succeed(subscription.intent) : checkIntent(patch.intent)
  return Result.map(intent, (intent) => {
    const { eventTypes: current, ...rest } = subscription
    const eventTypes = patch.eventTypes ?? current ?? []
    const lifetimeEnd = DateTime.addDuration(context.lastStart, context.limits.lifetime)
    const updated: Subscription = {
      ...rest,
      ...(Arr.isReadonlyArrayNonEmpty(eventTypes) ? { eventTypes } : {}),
      intent,
      ...(patch.maxEvents === undefined ? {} : { maxEvents: patch.maxEvents }),
      ...(patch.until === undefined ? {} : { expiresAt: DateTime.min(patch.until, lifetimeEnd) }),
      ...(patch.parameters === undefined ? {} : { parameters: patch.parameters }),
      ...(patch.label === undefined ? {} : { label: patch.label })
    }
    const reached = updated.maxEvents !== undefined && updated.lastNumber >= updated.maxEvents
    return reached
      ? Result.getOrElse(Lifecycle.end(updated, { _tag: "MaxEvents" }, context.now), () => ({
        subscription: updated,
        wake: Option.none()
      }))
      : { subscription: updated, wake: Option.none() }
  })
}

export const isOwn = (subscription: Subscription, caller: Session): boolean =>
  subscription.wakeTarget !== undefined && sameSession(subscription.wakeTarget, caller)
