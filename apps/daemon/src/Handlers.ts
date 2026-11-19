import {
  configureConnector,
  devLink,
  devUnlink,
  disableConnector,
  enableConnector,
  getSettings,
  Harnesses,
  importConnector,
  listConnectorAlerts,
  listConnectors,
  removeConnector,
  serviceStatus,
  setSettings,
  Subscriptions
} from "@exangelos/application"
import { DaemonContract, SessionHeaders } from "@exangelos/contracts"
import { Cause, Clock, Effect, Exit, type Layer, Option } from "effect"
import type { Headers } from "effect/http"
import { Rpc, type RpcGroup } from "effect/rpc"
import { version } from "./Build.ts"
import * as Errors from "./ContractErrors.ts"

interface Caller {
  readonly headers: Headers.Headers
}

const actor = ({ headers }: Caller) => SessionHeaders.actorFromHeaders(headers)
const detected = ({ headers }: Caller) => Option.toArray(SessionHeaders.fromHeaders(headers))

const lookup = { SubscriptionNotFound: Errors.subscriptionNotFound } as const

const polled: ReadonlySet<string> = new Set([
  "ListConnectors",
  "List",
  "Show",
  "Events",
  "ListConnectorAlerts",
  "GetSettings",
  "ServiceStatus"
])

const callerAnnotations = (caller: Caller): Record<string, string> => {
  const who = actor(caller)
  return who._tag === "Session"
    ? { actor: "session", harness: who.session.harness, session: who.session.sessionId }
    : { actor: "you" }
}

const errorTag = (error: unknown): string =>
  typeof error === "object" && error !== null && "_tag" in error ? String(error._tag) : typeof error

const errorOf = (cause: Cause.Cause<unknown>): string =>
  Option.match(Cause.findErrorOption(cause), {
    onNone: () => Cause.hasInterruptsOnly(cause) ? "interrupted" : "defect",
    onSome: errorTag
  })

const report = (method: string, exit: Exit.Exit<unknown, unknown>): Effect.Effect<void> => {
  if (Exit.isSuccess(exit)) {
    const log = polled.has(method) ? Effect.logDebug : Effect.logInfo
    return log("request handled").pipe(Effect.annotateLogs({ outcome: "ok" }))
  }
  const cause = exit.cause
  const log = Cause.hasInterruptsOnly(cause)
    ? Effect.logDebug
    : Cause.hasDies(cause)
    ? Effect.logError
    : Effect.logWarning
  return log("request failed", Cause.map(cause, errorTag)).pipe(Effect.annotateLogs({ outcome: "error", error: errorOf(cause) }))
}

export const logged = <A, E, R>(method: string, caller: Caller, handle: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.flatMap(Clock.currentTimeMillis, (startedAt) =>
    handle.pipe(
      Effect.onExit((exit) =>
        Effect.flatMap(Clock.currentTimeMillis, (endedAt) =>
          report(method, exit).pipe(Effect.annotateLogs({ durationMs: endedAt - startedAt }))))
    )).pipe(Effect.annotateLogs({ request: crypto.randomUUID(), method, ...callerAnnotations(caller) }))

type Handlers = RpcGroup.HandlersFrom<RpcGroup.Rpcs<typeof DaemonContract.DaemonContract>>

const instrumented = (handlers: Handlers): Handlers =>
  Object.fromEntries(
    Object.entries(handlers).map(([method, handle]) => [
      method,
      (payload: unknown, caller: Caller) => {
        const result = handle(payload as never, caller as never) as
          | Effect.Effect<unknown, unknown, unknown>
          | Rpc.Wrapper<Effect.Effect<unknown, unknown, unknown>>
        return Rpc.isWrapper(result)
          ? Rpc.wrap({ fork: result.fork, uninterruptible: result.uninterruptible })(logged(method, caller, result.value))
          : logged(method, caller, result)
      }
    ])
  ) as unknown as Handlers

export const layer = DaemonContract.DaemonContract.toLayer(instrumented({
  ListConnectors: () => listConnectors,
  Subscribe: (payload, caller) =>
    Subscriptions.subscribe(actor(caller), payload, detected(caller)).pipe(
      Effect.catchTags({
        IntentRequired: Errors.intentRequired,
        NoWakeTarget: Errors.noWakeTarget,
        UnknownHarness: Errors.unknownHarness,
        ConnectorNotFound: Errors.connectorNotFound,
        ConnectorUnavailable: Errors.connectorUnavailable,
        OfficialFetchFailed: Errors.officialFetchFailed,
        ParametersInvalid: Errors.parametersInvalid,
        SimilarSubscriptions: Errors.similarSubscriptions
      })
    ),
  Update: (payload, caller) =>
    Subscriptions.update(actor(caller), payload).pipe(
      Effect.catchTags({
        ...lookup,
        IntentRequired: Errors.intentRequired,
        ConnectorUnavailable: Errors.connectorUnavailable,
        ParametersInvalid: Errors.parametersInvalid,
        SubjectChanged: Errors.subjectChanged,
        ConnectorNotFound: Errors.connectorGoneOnUpdate,
        OfficialFetchFailed: Errors.officialFetchFailedOnUpdate
      })
    ),
  List: (payload, caller) => Subscriptions.list(actor(caller), payload),
  Show: (payload, caller) => Subscriptions.show(actor(caller), payload).pipe(Effect.catchTags(lookup)),
  Events: (payload, caller) => Subscriptions.events(actor(caller), payload).pipe(Effect.catchTags(lookup)),
  Ack: (payload, caller) => Subscriptions.acknowledge(actor(caller), payload).pipe(Effect.catchTags(lookup)),
  Wait: (payload, caller) => Subscriptions.wait(actor(caller), payload).pipe(Effect.catchTags(lookup)),
  Pause: (payload, caller) =>
    Subscriptions.pause(actor(caller), payload).pipe(
      Effect.catchTags({ ...lookup, NotAllowed: Errors.transitionRefused(payload.id) })
    ),
  Resume: (payload, caller) =>
    Subscriptions.resume(actor(caller), payload).pipe(
      Effect.catchTags({
        ...lookup,
        NotAllowed: Errors.transitionRefused(payload.id),
        BacklogOverLimit: Errors.backlogOverLimit
      })
    ),
  Retarget: (payload, caller) =>
    Subscriptions.retarget(actor(caller), payload, detected(caller)).pipe(
      Effect.catchTags({
        ...lookup,
        NoWakeTarget: Errors.noWakeTarget,
        UnknownHarness: Errors.unknownHarness
      })
    ),
  Cancel: (payload, caller) =>
    Subscriptions.cancel(actor(caller), payload).pipe(
      Effect.catchTags({ ...lookup, NotAllowed: Errors.transitionRefused(payload.id) })
    ),
  ImportConnector: ({ source }, caller) =>
    importConnector(actor(caller), source).pipe(
      Effect.catchTags({ NoSuchElementError: Errors.removedDuringImport, ImportFailed: Errors.importFailed })
    ),
  EnableConnector: ({ name, digest }, caller) =>
    enableConnector(actor(caller), name, digest).pipe(
      Effect.catchTags({
        NoSuchElementError: Errors.removedDuringCall(name),
        ConnectorNotFound: Errors.connectorNotFound,
        DigestMismatch: Errors.digestMismatch,
        HumanRequired: Errors.humanRequired
      })
    ),
  DisableConnector: ({ name }, caller) =>
    disableConnector(actor(caller), name).pipe(
      Effect.catchTags({ NoSuchElementError: Errors.removedDuringCall(name), ConnectorNotFound: Errors.connectorNotFound })
    ),
  RemoveConnector: ({ name }, caller) =>
    removeConnector(actor(caller), name).pipe(Effect.catchTags({ ConnectorNotFound: Errors.connectorNotFound })),
  ConfigureConnector: ({ name, values }, caller) =>
    configureConnector(actor(caller), name, values).pipe(
      Effect.catchTags({
        NoSuchElementError: Errors.removedDuringCall(name),
        ConnectorNotFound: Errors.connectorNotFound,
        ConnectorUnavailable: Errors.connectorUnavailable,
        ConfigurationInvalid: Errors.configurationInvalid,
        ConfigurationRejected: Errors.configurationRejected
      })
    ),
  DevLink: ({ path }, caller) =>
    devLink(actor(caller), path).pipe(
      Effect.catchTags({ NoSuchElementError: Errors.removedDuringImport, ImportFailed: Errors.importFailed })
    ),
  DevUnlink: ({ name }, caller) =>
    devUnlink(actor(caller), name).pipe(Effect.catchTags({ ConnectorNotFound: Errors.connectorNotFound })),
  ListConnectorAlerts: () => listConnectorAlerts,
  GetSettings: () => getSettings.pipe(Effect.catchTag("SettingsUnreadable", (e) => Effect.die(e))),
  SetSettings: ({ settings }, caller) =>
    setSettings(actor(caller), settings).pipe(
      Effect.catchTags({ SettingsOwnerOnly: Errors.settingsOwnerOnly, SettingsUnreadable: Effect.die, SettingsWriteFailed: Effect.die })
    ),
  SetHarness: ({ name, command }, caller) =>
    Harnesses.setHarness(actor(caller), name, { command }).pipe(
      Effect.catchTags({ HumanRequired: Errors.harnessOwnerOnly, SettingsUnreadable: Effect.die, SettingsWriteFailed: Effect.die })
    ),
  RemoveHarness: ({ name }, caller) =>
    Harnesses.removeHarness(actor(caller), name).pipe(
      Effect.catchTags({
        HumanRequired: Errors.harnessOwnerOnly,
        UnknownHarness: Errors.unknownHarness,
        SettingsUnreadable: Effect.die,
        SettingsWriteFailed: Effect.die
      })
    ),
  ServiceStatus: () =>
    serviceStatus.pipe(
      Effect.map((status) => status.method),
      Effect.catchTag("ServiceFailed", (e) =>
        Effect.as(Effect.logWarning("service status unavailable", Cause.fail(e)), e.method)),
      Effect.map((startMethod) => ({ version, startMethod }))
    ),
  SetEventAlerts: (payload, caller) =>
    Subscriptions.setEventAlerts(actor(caller), payload).pipe(
      Effect.catchTags({ ...lookup, HumanRequired: Errors.ownerOnlySubscription })
    )
}))

export type Requirements = typeof layer extends Layer.Layer<infer _A, infer _E, infer R> ? R : never
