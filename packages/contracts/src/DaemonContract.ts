import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import { Alert, Catalogue, Event, Ids, Connector, Session, Settings, Subscription, Wake } from "@exangelos/domain"

export class ConnectorNotFound extends Schema.TaggedError<ConnectorNotFound>()("ConnectorNotFound", {
  connector: Schema.String
}) {}

export class ConnectorUnavailable extends Schema.TaggedError<ConnectorUnavailable>()("ConnectorUnavailable", {
  connector: Ids.ConnectorName,
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
  limit: Schema.Int,
  /** The last event number the agent must acknowledge through before resume succeeds. */
  through: Ids.AckedThrough,
  /** `count`: more events are pending than the limit allows. `age`: the oldest pending event is too old. */
  reason: Schema.Literals(["count", "age"])
}) {}

export class OfficialFetchFailed extends Schema.TaggedError<OfficialFetchFailed>()("OfficialFetchFailed", {
  connector: Ids.ConnectorName,
  reason: Schema.String
}) {}

/** The call is the owner's alone, and a session made it. */
export class HumanRequired extends Schema.TaggedError<HumanRequired>()("HumanRequired", {
  connector: Schema.optionalKey(Ids.ConnectorName),
  subscription: Schema.optionalKey(Ids.SubscriptionId)
}) {}

export class ImportFailed extends Schema.TaggedError<ImportFailed>()("ImportFailed", {
  reason: Schema.String
}) {}

export class DigestMismatch extends Schema.TaggedError<DigestMismatch>()("DigestMismatch", {
  connector: Ids.ConnectorName,
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

export class ListConnectors extends Rpc.make("ListConnectors", {
  success: Schema.Array(Connector.Connector)
}) {}

export class Subscribe extends Rpc.make("Subscribe", {
  payload: {
    connector: Ids.ConnectorName,
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
    ConnectorNotFound,
    ConnectorUnavailable,
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
    ConnectorUnavailable,
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
  ListConnectors,
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

const name = { name: Ids.ConnectorName }

export class ImportConnector extends Rpc.make("ImportConnector", {
  payload: { source: ImportSource },
  success: Connector.Connector,
  error: ImportFailed
}) {}

export class EnableConnector extends Rpc.make("EnableConnector", {
  payload: { ...name, digest: Schema.NonEmptyString },
  success: Connector.Connector,
  error: Schema.Union([ConnectorNotFound, DigestMismatch, HumanRequired])
}) {}

export class DisableConnector extends Rpc.make("DisableConnector", {
  payload: name,
  success: Connector.Connector,
  error: ConnectorNotFound
}) {}

export class RemoveConnector extends Rpc.make("RemoveConnector", {
  payload: name,
  error: ConnectorNotFound
}) {}

export class ConfigureConnector extends Rpc.make("ConfigureConnector", {
  payload: { ...name, values: Catalogue.ConfigurationValues },
  success: Connector.Connector,
  error: Schema.Union([ConnectorNotFound, ConnectorUnavailable, ConfigurationInvalid, ConfigurationRejected])
}) {}

export class DevLink extends Rpc.make("DevLink", {
  payload: { path: Schema.NonEmptyString },
  success: Connector.Connector,
  error: ImportFailed
}) {}

export class DevUnlink extends Rpc.make("DevUnlink", {
  payload: name,
  error: ConnectorNotFound
}) {}

/**
 * One alert for each connector that waits for the owner because of its trust: `WaitsForEnable` for an
 * inert connector the owner can enable, `DigestMismatch` for an official connector whose files do not match
 * the checksum the binary carries. An official connector the owner disabled has no alert.
 */
export class ListConnectorAlerts extends Rpc.make("ListConnectorAlerts", {
  success: Schema.Array(Alert.Alert)
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

export class SetEventAlerts extends Rpc.make("SetEventAlerts", {
  payload: { ...id, eventAlerts: Schema.Boolean },
  success: Subscription.Subscription,
  error: Schema.Union([SubscriptionNotFound, InvalidRequest, HumanRequired])
}) {}

export class ManagementGroup extends RpcGroup.make(
  ImportConnector,
  EnableConnector,
  DisableConnector,
  RemoveConnector,
  ConfigureConnector,
  DevLink,
  DevUnlink,
  ListConnectorAlerts,
  GetSettings,
  SetSettings,
  ServiceStatus,
  SetEventAlerts
) {}

export const DaemonContract = AgentGroup.merge(ManagementGroup)
export type DaemonContract = typeof DaemonContract
