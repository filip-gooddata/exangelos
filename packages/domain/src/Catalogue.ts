import { Schema } from "effect"
import { EventType } from "./Ids.ts"

export const JsonSchema = Schema.Record(Schema.String, Schema.Unknown)
export type JsonSchema = typeof JsonSchema.Type

export const EventTypeSpec = Schema.Struct({
  type: EventType,
  description: Schema.String,
  payload: JsonSchema
})
export type EventTypeSpec = typeof EventTypeSpec.Type

export const ParametersSpec = Schema.Struct({
  main: Schema.NonEmptyString,
  schema: JsonSchema
})
export type ParametersSpec = typeof ParametersSpec.Type

const fieldBase = {
  key: Schema.NonEmptyString,
  label: Schema.String,
  required: Schema.Boolean
}

export const ConfigurationField = Schema.TaggedUnion({
  Text: { ...fieldBase, secretDestination: Schema.Boolean },
  Choice: { ...fieldBase, choices: Schema.NonEmptyArray(Schema.String), secretDestination: Schema.Boolean },
  Secret: fieldBase
})
export type ConfigurationField = typeof ConfigurationField.Type

export const Catalogue = Schema.Struct({
  eventTypes: Schema.NonEmptyArray(EventTypeSpec),
  parameters: ParametersSpec,
  configuration: Schema.Array(ConfigurationField)
})
export type Catalogue = typeof Catalogue.Type

export const Parameters = Schema.Record(Schema.String, Schema.Unknown)
export type Parameters = typeof Parameters.Type

export const ConfigurationValues = Schema.Record(Schema.String, Schema.String)
export type ConfigurationValues = typeof ConfigurationValues.Type
