import { Context, Schema } from "effect"
import type { Effect, Scope, Stream } from "effect"
import { Catalogue, Event, Ids } from "@exangelos/domain"

export const Entry = Schema.TaggedUnion({
  Bundle: { path: Schema.String },
  Native: { path: Schema.String }
})
export type Entry = typeof Entry.Type

export const Launch = Schema.Struct({
  name: Ids.PluginName,
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
  cursor: Schema.optionalKey(Schema.String)
})
export type WatchRequest = typeof WatchRequest.Type

export class PluginStartFailed extends Schema.TaggedError<PluginStartFailed>()("PluginStartFailed", {
  plugin: Ids.PluginName,
  reason: Schema.String
}) {}

export class IncompatibleProtocol extends Schema.TaggedError<IncompatibleProtocol>()("IncompatibleProtocol", {
  plugin: Ids.PluginName,
  version: Schema.Int,
  supported: Schema.Array(Schema.Int)
}) {}

export class PluginCrashed extends Schema.TaggedError<PluginCrashed>()("PluginCrashed", {
  plugin: Ids.PluginName,
  reason: Schema.String
}) {}

export class CredentialsRejected extends Schema.TaggedError<CredentialsRejected>()("CredentialsRejected", {
  plugin: Ids.PluginName,
  reason: Schema.String
}) {}

export class SourceFailed extends Schema.TaggedError<SourceFailed>()("SourceFailed", {
  plugin: Ids.PluginName,
  reason: Schema.String
}) {}

export interface PluginProcess {
  readonly catalogue: Catalogue.Catalogue
  readonly configure: (values: Catalogue.ConfigurationValues) => Effect.Effect<ConfigureAnswer, PluginCrashed>
  readonly describe: (parameters: Catalogue.Parameters) => Effect.Effect<DescribeAnswer, PluginCrashed>
  readonly watch: (
    request: WatchRequest
  ) => Stream.Stream<Event.WatchItem, PluginCrashed | CredentialsRejected | SourceFailed>
  readonly exited: Effect.Effect<PluginCrashed>
}

export class PluginRuntime extends Context.Service<PluginRuntime, {
  readonly start: (
    launch: Launch
  ) => Effect.Effect<PluginProcess, PluginStartFailed | IncompatibleProtocol, Scope.Scope>
}>()("@exangelos/application/PluginRuntime") {}
