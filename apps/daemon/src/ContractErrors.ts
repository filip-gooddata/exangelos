import { type Cause, Effect, Option } from "effect"
import type {
  ConfigurationInvalid,
  DigestMismatch,
  HumanRequired,
  ConfigurationRejected,
  OfficialConnectorSource,
  ConnectorAccess,
  ConnectorImportSource,
  Harnesses,
  SubscriptionNotFound,
  Subscriptions
} from "@exangelos/application"
import { currentLimits, SubscriptionRepository } from "@exangelos/application"
import { DaemonContract as Contract } from "@exangelos/contracts"
import type { Ids, Refusal } from "@exangelos/domain"


export const subscriptionNotFound = (e: SubscriptionNotFound) =>
  Effect.fail(new Contract.SubscriptionNotFound({ id: e.id }))

export const intentRequired = (e: Refusal.IntentRequired) => Effect.fail(new Contract.InvalidRequest({ message: e.message }))

export const noWakeTarget = (_: Refusal.NoWakeTarget) =>
  Effect.fail(
    new Contract.NoWakeTarget({
      message: "No agent session to wake: call from an agent session, name a session, or choose pull-only."
    })
  )

export const unknownHarness = (e: Harnesses.UnknownHarness) =>
  Effect.fail(
    new Contract.UnknownHarness({
      harness: e.harness,
      message: `No harness named "${e.harness}". You define one with exangelos settings harness set.`
    })
  )

export const harnessOwnerOnly = (e: Harnesses.HumanRequired) => Effect.fail(new Contract.HumanRequired({ harness: e.harness }))

export const connectorNotFound = (e: ConnectorAccess.ConnectorNotFound) => Effect.fail(new Contract.ConnectorNotFound({ connector: e.connector }))

export const connectorUnavailable = (e: Refusal.ConnectorUnavailable) =>
  Effect.fail(new Contract.ConnectorUnavailable({ connector: e.connector, problem: e.problem }))

export const connectorGoneOnUpdate = (e: ConnectorAccess.ConnectorNotFound) =>
  Effect.fail(new Contract.ConnectorUnavailable({ connector: e.connector, problem: "it is not installed" }))

export const officialFetchFailedOnUpdate = (e: OfficialConnectorSource.OfficialFetchFailed) =>
  Effect.fail(new Contract.ConnectorUnavailable({ connector: e.connector, problem: `its official files could not be fetched: ${e.reason}` }))

export const officialFetchFailed = (e: OfficialConnectorSource.OfficialFetchFailed) =>
  Effect.fail(new Contract.OfficialFetchFailed({ connector: e.connector, reason: e.reason }))

export const parametersInvalid = (e: Refusal.ParametersInvalid) =>
  Effect.fail(new Contract.ParametersInvalid({ reason: e.reason }))

export const subjectChanged = (e: Refusal.SubjectChanged) =>
  Effect.fail(new Contract.SubjectChanged({ from: e.subject, to: e.reported }))

export const importFailed = (e: ConnectorImportSource.ImportFailed) => Effect.fail(new Contract.ImportFailed({ reason: e.reason }))

export const removedDuringCall = (connector: Ids.ConnectorName) => (_: Cause.NoSuchElementError) =>
  Effect.fail(new Contract.ConnectorNotFound({ connector }))

export const removedDuringImport = (_: Cause.NoSuchElementError) =>
  Effect.fail(new Contract.ImportFailed({ reason: "Another call removed the connector while it was being imported." }))

export const humanRequired = (e: HumanRequired) => Effect.fail(new Contract.HumanRequired({ connector: e.connector }))

export const ownerOnlySubscription = (e: Subscriptions.HumanRequired) =>
  Effect.fail(new Contract.HumanRequired({ subscription: e.subscription }))

export const digestMismatch = (e: DigestMismatch) =>
  Effect.fail(new Contract.DigestMismatch({ connector: e.connector, expected: e.expected, actual: e.actual }))

export const configurationInvalid = (e: ConfigurationInvalid) =>
  Effect.fail(new Contract.ConfigurationInvalid({ reason: e.reason }))

export const configurationRejected = (e: ConfigurationRejected) =>
  Effect.fail(new Contract.ConfigurationRejected({ reason: e.reason }))

export const similarSubscriptions = (e: Refusal.SimilarSubscriptions) =>
  Effect.gen(function*() {
    const repository = yield* SubscriptionRepository.SubscriptionRepository
    const found = yield* Effect.forEach(e.matches, (match) => repository.find(match.id))
    const [first, ...rest] = found.flatMap(Option.toArray)
    if (first === undefined) {
      return yield* new Contract.InvalidRequest({ message: "The similar subscriptions are gone; subscribe again." })
    }
    return yield* new Contract.SimilarSubscriptions({ similar: [first, ...rest] })
  })

export const transitionRefused = (id: Ids.SubscriptionId) => (e: Refusal.NotAllowed) =>
  Effect.gen(function*() {
    const subscription = yield* (yield* SubscriptionRepository.SubscriptionRepository).find(id)
    if (Option.isNone(subscription)) return yield* new Contract.SubscriptionNotFound({ id })
    return yield* new Contract.TransitionRefused({
      state: subscription.value.state,
      message: `Cannot ${e.action} a subscription that is ${subscription.value.state._tag.toLowerCase()}.`
    })
  })

export const backlogOverLimit = (e: Refusal.BacklogOverLimit) =>
  Effect.gen(function*() {
    const limits = yield* currentLimits
    return yield* new Contract.BacklogOverLimit({
      pending: e.pending,
      limit: limits.backlogCount,
      through: e.through,
      reason: e.pending >= limits.backlogCount ? "count" : "age"
    })
  })
