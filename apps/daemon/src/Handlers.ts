import {
  configurePlugin,
  devLink,
  devUnlink,
  disablePlugin,
  enablePlugin,
  getSettings,
  importPlugin,
  listPluginAlerts,
  listPlugins,
  removePlugin,
  serviceStatus,
  setSettings,
  Subscriptions
} from "@exangelos/application"
import { DaemonContract, SessionHeaders } from "@exangelos/contracts"
import { Effect, type Layer, Option } from "effect"
import type { Headers } from "effect/http"
import { version } from "./Build.ts"
import * as Errors from "./ContractErrors.ts"

interface Caller {
  readonly headers: Headers.Headers
}

const actor = ({ headers }: Caller) => SessionHeaders.actorFromHeaders(headers)
const detected = ({ headers }: Caller) => Option.toArray(SessionHeaders.fromHeaders(headers))

const lookup = { SubscriptionNotFound: Errors.subscriptionNotFound } as const

export const layer = DaemonContract.DaemonContract.toLayer({
  ListPlugins: () => listPlugins,
  Subscribe: (payload, caller) =>
    Subscriptions.subscribe(actor(caller), payload, detected(caller)).pipe(
      Effect.catchTags({
        IntentRequired: Errors.intentRequired,
        NoWakeTarget: Errors.noWakeTarget,
        PluginNotFound: Errors.pluginNotFound,
        PluginUnavailable: Errors.pluginUnavailable,
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
        PluginUnavailable: Errors.pluginUnavailable,
        ParametersInvalid: Errors.parametersInvalid,
        SubjectChanged: Errors.subjectChanged,
        PluginNotFound: Errors.pluginGoneOnUpdate,
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
        NoWakeTarget: Errors.noWakeTarget
      })
    ),
  Cancel: (payload, caller) =>
    Subscriptions.cancel(actor(caller), payload).pipe(
      Effect.catchTags({ ...lookup, NotAllowed: Errors.transitionRefused(payload.id) })
    ),
  ImportPlugin: ({ source }, caller) =>
    importPlugin(actor(caller), source).pipe(
      Effect.catchTags({ NoSuchElementError: Errors.removedDuringImport, ImportFailed: Errors.importFailed })
    ),
  EnablePlugin: ({ name, digest }, caller) =>
    enablePlugin(actor(caller), name, digest).pipe(
      Effect.catchTags({
        NoSuchElementError: Errors.removedDuringCall(name),
        PluginNotFound: Errors.pluginNotFound,
        DigestMismatch: Errors.digestMismatch,
        HumanRequired: Errors.humanRequired
      })
    ),
  DisablePlugin: ({ name }, caller) =>
    disablePlugin(actor(caller), name).pipe(
      Effect.catchTags({ NoSuchElementError: Errors.removedDuringCall(name), PluginNotFound: Errors.pluginNotFound })
    ),
  RemovePlugin: ({ name }, caller) =>
    removePlugin(actor(caller), name).pipe(Effect.catchTags({ PluginNotFound: Errors.pluginNotFound })),
  ConfigurePlugin: ({ name, values }, caller) =>
    configurePlugin(actor(caller), name, values).pipe(
      Effect.catchTags({
        NoSuchElementError: Errors.removedDuringCall(name),
        PluginNotFound: Errors.pluginNotFound,
        PluginUnavailable: Errors.pluginUnavailable,
        ConfigurationInvalid: Errors.configurationInvalid,
        ConfigurationRejected: Errors.configurationRejected
      })
    ),
  DevLink: ({ path }, caller) =>
    devLink(actor(caller), path).pipe(
      Effect.catchTags({ NoSuchElementError: Errors.removedDuringImport, ImportFailed: Errors.importFailed })
    ),
  DevUnlink: ({ name }, caller) =>
    devUnlink(actor(caller), name).pipe(Effect.catchTags({ PluginNotFound: Errors.pluginNotFound })),
  ListPluginAlerts: () => listPluginAlerts,
  GetSettings: () => getSettings.pipe(Effect.catchTag("SettingsUnreadable", (e) => Effect.die(e))),
  SetSettings: ({ settings }) => setSettings(settings).pipe(Effect.catchTag("SettingsWriteFailed", (e) => Effect.die(e))),
  ServiceStatus: () =>
    serviceStatus.pipe(
      Effect.map((status) => status.method),
      Effect.catchTag("ServiceFailed", (e) =>
        Effect.as(Effect.logWarning("Service status unavailable", e.reason), e.method)),
      Effect.map((startMethod) => ({ version, startMethod }))
    )
})

export type Requirements = typeof layer extends Layer.Layer<infer _A, infer _E, infer R> ? R : never
