import { type Cause, Effect, Option } from "effect"
import type {
  ConfigurationInvalid,
  DigestMismatch,
  HumanRequired,
  ConfigurationRejected,
  OfficialPluginSource,
  PluginAccess,
  PluginImportSource,
  SubscriptionNotFound
} from "@exangelos/application"
import { currentLimits, SubscriptionRepository } from "@exangelos/application"
import { DaemonContract as Contract } from "@exangelos/contracts"
import type { Ids, Refusal } from "@exangelos/domain"

/** Turns use case errors into the errors DaemonContract declares, one function per error. */

export const subscriptionNotFound = (e: SubscriptionNotFound) =>
  Effect.fail(new Contract.SubscriptionNotFound({ id: e.id }))

export const intentRequired = (e: Refusal.IntentRequired) => Effect.fail(new Contract.InvalidRequest({ message: e.message }))

export const noWakeTarget = (_: Refusal.NoWakeTarget) =>
  Effect.fail(
    new Contract.NoWakeTarget({
      message: "No agent session to wake: call from an agent session, name a session, or choose pull-only."
    })
  )

export const pluginNotFound = (e: PluginAccess.PluginNotFound) => Effect.fail(new Contract.PluginNotFound({ plugin: e.plugin }))

export const pluginUnavailable = (e: Refusal.PluginUnavailable) =>
  Effect.fail(new Contract.PluginUnavailable({ plugin: e.plugin, problem: e.problem }))

/** Update declares neither missing plugin error; the nearest it has is PluginUnavailable. */
export const pluginGoneOnUpdate = (e: PluginAccess.PluginNotFound) =>
  Effect.fail(new Contract.PluginUnavailable({ plugin: e.plugin, problem: "it is not installed" }))

export const officialFetchFailedOnUpdate = (e: OfficialPluginSource.OfficialFetchFailed) =>
  Effect.fail(new Contract.PluginUnavailable({ plugin: e.plugin, problem: `its official files could not be fetched: ${e.reason}` }))

export const officialFetchFailed = (e: OfficialPluginSource.OfficialFetchFailed) =>
  Effect.fail(new Contract.OfficialFetchFailed({ plugin: e.plugin, reason: e.reason }))

export const parametersInvalid = (e: Refusal.ParametersInvalid) =>
  Effect.fail(new Contract.ParametersInvalid({ reason: e.reason }))

export const subjectChanged = (e: Refusal.SubjectChanged) =>
  Effect.fail(new Contract.SubjectChanged({ from: e.subject, to: e.reported }))

export const importFailed = (e: PluginImportSource.ImportFailed) => Effect.fail(new Contract.ImportFailed({ reason: e.reason }))

/**
 * Another call removed the plugin record between a use case's write and its read back. The
 * contract has no error for that race, so it is a defect.
 */
export const vanished = (e: Cause.NoSuchElementError) => Effect.die(e)

/**
 * Only the owner enables a plugin, so a call from an agent session is refused. The contract has no
 * HumanRequired error yet, so the refusal is a defect that names the plugin.
 */
export const humanRequired = (e: HumanRequired) => Effect.die(e)

export const digestMismatch = (e: DigestMismatch) =>
  Effect.fail(new Contract.DigestMismatch({ plugin: e.plugin, expected: e.expected, actual: e.actual }))

/** configurePlugin redacts the reason before it fails, so it holds no secret value. */
export const configurationInvalid = (e: ConfigurationInvalid) =>
  Effect.fail(new Contract.ConfigurationInvalid({ reason: e.reason }))

export const configurationRejected = (e: ConfigurationRejected) =>
  Effect.fail(new Contract.ConfigurationRejected({ reason: e.reason }))

/** The contract names the similar subscriptions in full, the domain by id. */
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

/** The domain refusal names the state by tag; the contract carries the subscription's whole state. */
export const transitionRefused = (id: Ids.SubscriptionId) => (e: Refusal.NotAllowed) =>
  Effect.gen(function*() {
    const subscription = yield* (yield* SubscriptionRepository.SubscriptionRepository).find(id)
    if (Option.isNone(subscription)) return yield* new Contract.SubscriptionNotFound({ id })
    return yield* new Contract.TransitionRefused({
      state: subscription.value.state,
      message: `Cannot ${e.action} a subscription that is ${e.state.toLowerCase()}.`
    })
  })

/** The limit is the backlog count from the settings that resume checked against. */
export const backlogOverLimit = (e: Refusal.BacklogOverLimit) =>
  Effect.gen(function*() {
    const limits = yield* currentLimits
    return yield* new Contract.BacklogOverLimit({
      pending: e.pending,
      limit: limits.backlogCount,
      through: e.through
    })
  })
