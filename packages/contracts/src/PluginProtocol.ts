import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import { Catalogue, Event, Ids } from "@exangelos/domain"

export const version = 1

export class Handshake extends Rpc.make("Handshake", {
  success: Schema.Struct({
    protocolVersion: Schema.Int,
    catalogue: Catalogue.Catalogue
  })
}) {}

export const ConfigureAnswer = Schema.TaggedUnion({
  Accepted: {},
  Rejected: { reason: Schema.String }
})
export type ConfigureAnswer = typeof ConfigureAnswer.Type

export class Configure extends Rpc.make("Configure", {
  payload: { values: Catalogue.ConfigurationValues },
  success: ConfigureAnswer
}) {}

export const DescribeAnswer = Schema.TaggedUnion({
  Described: { parameters: Catalogue.Parameters, subject: Schema.NonEmptyString, label: Schema.String },
  Invalid: { reason: Schema.String }
})
export type DescribeAnswer = typeof DescribeAnswer.Type

export class Describe extends Rpc.make("Describe", {
  payload: { parameters: Catalogue.Parameters },
  success: DescribeAnswer
}) {}

export class CredentialsRejected extends Schema.TaggedError<CredentialsRejected>()("CredentialsRejected", {
  reason: Schema.String
}) {}

export class SourceFailed extends Schema.TaggedError<SourceFailed>()("SourceFailed", {
  reason: Schema.String
}) {}

export const WatchError = Schema.Union([CredentialsRejected, SourceFailed])
export type WatchError = typeof WatchError.Type

export class Watch extends Rpc.make("Watch", {
  payload: {
    parameters: Catalogue.Parameters,
    eventTypes: Schema.Array(Ids.EventType),
    cursor: Schema.optionalKey(Schema.String)
  },
  success: Event.WatchItem,
  error: WatchError,
  stream: true
}) {}

export class PluginProtocol extends RpcGroup.make(Handshake, Configure, Describe, Watch) {}
