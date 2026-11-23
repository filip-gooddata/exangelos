import { Context, Schema } from "effect"
import type { Effect, Scope, Stream } from "effect"
import { Catalogue, Connector, Event, Ids } from "@exangelos/domain"

export const Entry = Schema.TaggedUnion({
  Bundle: { path: Schema.String },
  Native: { path: Schema.String }
})
export type Entry = typeof Entry.Type

export const Launch = Schema.Struct({
  name: Ids.ConnectorName,
  directory: Schema.String,
  entry: Entry,
  dev: Schema.Boolean
})
export type Launch = typeof Launch.Type

export const ConfigureAnswer = Schema.TaggedUnion({
  Accepted: {},
  Rejected: { reason: Schema.String }
})
export type ConfigureAnswer = typeof ConfigureAnswer.Type

export const DescribeAnswer = Schema.TaggedUnion({
  Described: { parameters: Catalogue.Parameters, subject: Schema.NonEmptyString, label: Schema.String },
  Invalid: { reason: Schema.String }
})
export type DescribeAnswer = typeof DescribeAnswer.Type

export const WatchRequest = Schema.Struct({
  parameters: Catalogue.Parameters,
  eventTypes: Schema.Array(Ids.EventType),
  cursor: Schema.optionalKey(Schema.String),
  wakeWindow: Schema.DurationFromMillis
})
export type WatchRequest = typeof WatchRequest.Type

export class ConnectorStartFailed extends Schema.TaggedError<ConnectorStartFailed>()("ConnectorStartFailed", {
  connector: Ids.ConnectorName,
  reason: Schema.String
}) {}

export class IncompatibleProtocol extends Schema.TaggedError<IncompatibleProtocol>()("IncompatibleProtocol", {
  connector: Ids.ConnectorName,
  version: Schema.Int,
  supported: Schema.Array(Schema.Int)
}) {}

export class ConnectorCrashed extends Schema.TaggedError<ConnectorCrashed>()("ConnectorCrashed", {
  connector: Ids.ConnectorName,
  reason: Schema.String
}) {}

export class CredentialsRejected extends Schema.TaggedError<CredentialsRejected>()("CredentialsRejected", {
  connector: Ids.ConnectorName,
  reason: Schema.String
}) {}

export class SourceFailed extends Schema.TaggedError<SourceFailed>()("SourceFailed", {
  connector: Ids.ConnectorName,
  reason: Schema.String,
  category: Schema.optionalKey(Connector.ObservationCategory)
}) {}

export interface ConnectorProcess {
  readonly catalogue: Catalogue.Catalogue
  readonly configure: (values: Catalogue.ConfigurationValues) => Effect.Effect<ConfigureAnswer, ConnectorCrashed>
  readonly describe: (parameters: Catalogue.Parameters) => Effect.Effect<DescribeAnswer, ConnectorCrashed>
  readonly watch: (
    request: WatchRequest
  ) => Stream.Stream<Event.WatchItem, ConnectorCrashed | CredentialsRejected | SourceFailed>
  readonly exited: Effect.Effect<ConnectorCrashed>
}

export class ConnectorRuntime extends Context.Service<ConnectorRuntime, {
  readonly start: (
    launch: Launch
  ) => Effect.Effect<ConnectorProcess, ConnectorStartFailed | IncompatibleProtocol, Scope.Scope>
}>()("@exangelos/application/ConnectorRuntime") {}
