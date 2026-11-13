import { Schema } from "effect"
import { Parameters } from "./Catalogue.ts"
import { ConnectorName, SubscriptionId } from "./Ids.ts"

export class IntentRequired extends Schema.TaggedError<IntentRequired>()("IntentRequired", {
  message: Schema.String
}) {}

export class ConnectorUnavailable extends Schema.TaggedError<ConnectorUnavailable>()("ConnectorUnavailable", {
  connector: ConnectorName,
  problem: Schema.String
}) {}

export class ParametersInvalid extends Schema.TaggedError<ParametersInvalid>()("ParametersInvalid", {
  reason: Schema.String
}) {}

export class NoWakeTarget extends Schema.TaggedError<NoWakeTarget>()("NoWakeTarget", {}) {}

export const SimilarMatch = Schema.Struct({ id: SubscriptionId, parameters: Parameters })
export type SimilarMatch = typeof SimilarMatch.Type

export class SimilarSubscriptions extends Schema.TaggedError<SimilarSubscriptions>()("SimilarSubscriptions", {
  matches: Schema.NonEmptyArray(SimilarMatch)
}) {}

export class SubjectChanged extends Schema.TaggedError<SubjectChanged>()("SubjectChanged", {
  subject: Schema.String,
  reported: Schema.String
}) {}

export class BacklogOverLimit extends Schema.TaggedError<BacklogOverLimit>()("BacklogOverLimit", {
  pending: Schema.Int,
  through: Schema.Int
}) {}

export class NotAllowed extends Schema.TaggedError<NotAllowed>()("NotAllowed", {
  action: Schema.Literals(["pause", "resume", "end", "cancel"]),
  state: Schema.String
}) {}
