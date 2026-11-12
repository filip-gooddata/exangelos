import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import { Catalogue, Event, Ids, Plugin, Session, Settings, Subscription, Wake } from "@exangelos/domain"

export class PluginNotFound extends Schema.TaggedError<PluginNotFound>()("PluginNotFound", {
  plugin: Schema.String
}) {}

export class PluginUnavailable extends Schema.TaggedError<PluginUnavailable>()("PluginUnavailable", {
  plugin: Ids.PluginName,
  problem: Schema.String
}) {}

export class SubscriptionNotFound extends Schema.TaggedError<SubscriptionNotFound>()("SubscriptionNotFound", {
  id: Schema.String
}) {}

export class InvalidRequest extends Schema.TaggedError<InvalidRequest>()("InvalidRequest", {
  message: Schema.String
}) {}

export class NoWakeTarget extends Schema.TaggedError<NoWakeTarget>()("NoWakeTarget", {
  message: Schema.String
}) {}

export class ParametersInvalid extends Schema.TaggedError<ParametersInvalid>()("ParametersInvalid", {
  reason: Schema.String
}) {}

export class SimilarSubscriptions extends Schema.TaggedError<SimilarSubscriptions>()("SimilarSubscriptions", {
  similar: Schema.NonEmptyArray(Subscription.Subscription)
}) {}

export class SubjectChanged extends Schema.TaggedError<SubjectChanged>()("SubjectChanged", {
  from: Schema.String,
  to: Schema.String
}) {}

export class TransitionRefused extends Schema.TaggedError<TransitionRefused>()("TransitionRefused", {
  state: Subscription.State,
  message: Schema.String
}) {}

export class BacklogOverLimit extends Schema.TaggedError<BacklogOverLimit>()("BacklogOverLimit", {
  pending: Schema.Int,
  limit: Schema.Int
}) {}

export class OfficialFetchFailed extends Schema.TaggedError<OfficialFetchFailed>()("OfficialFetchFailed", {
  plugin: Ids.PluginName,
  reason: Schema.String
}) {}

export class ImportFailed extends Schema.TaggedError<ImportFailed>()("ImportFailed", {
  reason: Schema.String
}) {}

export class DigestMismatch extends Schema.TaggedError<DigestMismatch>()("DigestMismatch", {
  plugin: Ids.PluginName,
  expected: Schema.String,
  actual: Schema.String
}) {}

export class ConfigurationInvalid extends Schema.TaggedError<ConfigurationInvalid>()("ConfigurationInvalid", {
  reason: Schema.String
}) {}

export class ConfigurationRejected extends Schema.TaggedError<ConfigurationRejected>()("ConfigurationRejected", {
  reason: Schema.String
}) {}

export const TargetChoice = Schema.TaggedUnion({
  Caller: {},
  Session: { session: Session.Session },
  PullOnly: {}
})
export type TargetChoice = typeof TargetChoice.Type

const SubscriptionLookup = Schema.Union([SubscriptionNotFound, InvalidRequest])
const id = { id: Ids.SubscriptionId }

export class ListPlugins extends Rpc.make("ListPlugins", {
  success: Schema.Array(Plugin.Plugin)
}) {}

export class Subscribe extends Rpc.make("Subscribe", {
  payload: {
    plugin: Ids.PluginName,
    main: Schema.optionalKey(Schema.String),
    parameters: Catalogue.Parameters,
    intent: Schema.NonEmptyString,
    eventTypes: Schema.optionalKey(Schema.NonEmptyArray(Ids.EventType)),
    maxEvents: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
    until: Schema.optionalKey(Schema.DateTimeUtc),
    target: TargetChoice,
    similarOk: Schema.Array(Ids.SubscriptionId)
  },
  success: Subscription.Subscription,
  error: Schema.Union([
    PluginNotFound,
    PluginUnavailable,
    OfficialFetchFailed,
    InvalidRequest,
    NoWakeTarget,
    ParametersInvalid,
    SimilarSubscriptions
  ])
}) {}

export class Update extends Rpc.make("Update", {
  payload: {
    ...id,
    intent: Schema.optionalKey(Schema.NonEmptyString),
    eventTypes: Schema.optionalKey(Schema.NonEmptyArray(Ids.EventType)),
    maxEvents: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
    until: Schema.optionalKey(Schema.DateTimeUtc),
    parameters: Schema.optionalKey(Catalogue.Parameters)
  },
  success: Subscription.Subscription,
  error: Schema.Union([
    SubscriptionNotFound,
    InvalidRequest,
    PluginUnavailable,
    ParametersInvalid,
    SubjectChanged,
    TransitionRefused
  ])
}) {}

export class List extends Rpc.make("List", {
  payload: { all: Schema.Boolean },
  success: Schema.Array(Subscription.Subscription)
}) {}

export const Details = Schema.Struct({
  subscription: Subscription.Subscription,
  events: Schema.Array(Event.Event),
  wakes: Schema.Array(Wake.Wake),
  changes: Schema.Array(Subscription.Change)
})
export type Details = typeof Details.Type

export class Show extends Rpc.make("Show", {
  payload: id,
  success: Details,
  error: SubscriptionLookup
}) {}

export class Events extends Rpc.make("Events", {
  payload: { ...id, after: Schema.optionalKey(Ids.AckedThrough) },
  success: Schema.Array(Event.Event),
  error: SubscriptionLookup
}) {}

export class Ack extends Rpc.make("Ack", {
  payload: { ...id, through: Ids.AckedThrough },
  success: Subscription.Subscription,
  error: SubscriptionLookup
}) {}

export class Wait extends Rpc.make("Wait", {
  payload: id,
  success: Wake.WakeContent,
  error: SubscriptionLookup
}) {}

export class Pause extends Rpc.make("Pause", {
  payload: id,
  success: Subscription.Subscription,
  error: Schema.Union([SubscriptionNotFound, InvalidRequest, TransitionRefused])
}) {}

export class Resume extends Rpc.make("Resume", {
  payload: id,
  success: Subscription.Subscription,
  error: Schema.Union([SubscriptionNotFound, InvalidRequest, TransitionRefused, BacklogOverLimit])
}) {}

export class Retarget extends Rpc.make("Retarget", {
  payload: { ...id, target: TargetChoice },
  success: Subscription.Subscription,
  error: Schema.Union([SubscriptionNotFound, InvalidRequest, NoWakeTarget, TransitionRefused])
}) {}

export class Cancel extends Rpc.make("Cancel", {
  payload: id,
  success: Subscription.Subscription,
  error: Schema.Union([SubscriptionNotFound, InvalidRequest, TransitionRefused])
}) {}

export class AgentGroup extends RpcGroup.make(
  ListPlugins,
  Subscribe,
  Update,
  List,
  Show,
  Events,
  Ack,
  Wait,
  Pause,
  Resume,
  Retarget,
  Cancel
) {}

export const ImportSource = Schema.TaggedUnion({
  ArchiveFile: { path: Schema.NonEmptyString },
  HttpsLink: { url: Schema.NonEmptyString },
  Directory: { path: Schema.NonEmptyString },
  GitRepository: { url: Schema.NonEmptyString, ref: Schema.NonEmptyString }
})
export type ImportSource = typeof ImportSource.Type

const name = { name: Ids.PluginName }

export class ImportPlugin extends Rpc.make("ImportPlugin", {
  payload: { source: ImportSource },
  success: Plugin.Plugin,
  error: ImportFailed
}) {}

export class EnablePlugin extends Rpc.make("EnablePlugin", {
  payload: { ...name, digest: Schema.NonEmptyString },
  success: Plugin.Plugin,
  error: Schema.Union([PluginNotFound, DigestMismatch])
}) {}

export class DisablePlugin extends Rpc.make("DisablePlugin", {
  payload: name,
  success: Plugin.Plugin,
  error: PluginNotFound
}) {}

export class RemovePlugin extends Rpc.make("RemovePlugin", {
  payload: name,
  error: PluginNotFound
}) {}

export class ConfigurePlugin extends Rpc.make("ConfigurePlugin", {
  payload: { ...name, values: Catalogue.ConfigurationValues },
  success: Plugin.Plugin,
  error: Schema.Union([PluginNotFound, PluginUnavailable, ConfigurationInvalid, ConfigurationRejected])
}) {}

export class DevLink extends Rpc.make("DevLink", {
  payload: { path: Schema.NonEmptyString },
  success: Plugin.Plugin,
  error: ImportFailed
}) {}

export class DevUnlink extends Rpc.make("DevUnlink", {
  payload: name,
  error: PluginNotFound
}) {}

export class GetSettings extends Rpc.make("GetSettings", {
  success: Settings.Settings
}) {}

export class SetSettings extends Rpc.make("SetSettings", {
  payload: { settings: Settings.Settings },
  success: Settings.Settings,
  error: InvalidRequest
}) {}

export const StartMethod = Schema.Literals(["homebrew", "launch-agent", "systemd-user", "foreground"])
export type StartMethod = typeof StartMethod.Type

export class ServiceStatus extends Rpc.make("ServiceStatus", {
  success: Schema.Struct({ version: Schema.String, startMethod: StartMethod })
}) {}

export class ManagementGroup extends RpcGroup.make(
  ImportPlugin,
  EnablePlugin,
  DisablePlugin,
  RemovePlugin,
  ConfigurePlugin,
  DevLink,
  DevUnlink,
  GetSettings,
  SetSettings,
  ServiceStatus
) {}

export const DaemonContract = AgentGroup.merge(ManagementGroup)
export type DaemonContract = typeof DaemonContract
