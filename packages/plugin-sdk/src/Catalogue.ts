import { DateTime, Schema } from "effect"
import { Catalogue as Wire, Event, Ids } from "@exangelos/domain"

export interface EventType<Payload> {
  readonly type: Ids.EventType
  readonly spec: Wire.EventTypeSpec
  readonly item: (fields: {
    readonly occurredAt: DateTime.Utc
    readonly summary: string
    readonly payload: Payload
    readonly dedupeKey: string
    readonly link?: string
    readonly cursor?: string
  }) => Event.WatchItem
}

export interface Parameters<P> {
  readonly schema: Schema.Codec<P, unknown>
  readonly spec: Wire.ParametersSpec
}

export type ConfigurationField = Wire.ConfigurationField

const toJsonSchema = (schema: Schema.Top): Wire.JsonSchema => {
  const document = Schema.toJsonSchemaDocument(schema)
  return Object.keys(document.definitions).length === 0
    ? { ...document.schema }
    : { ...document.schema, $defs: document.definitions }
}

export const event = <S extends Schema.Codec<any, any>>(
  type: string,
  options: { readonly description: string; readonly payload: S }
): EventType<S["Type"]> => {
  const eventType = Ids.EventType.make(type)
  const encodePayload = Schema.encodeSync(Schema.toCodecJson(options.payload))
  return {
    type: eventType,
    spec: { type: eventType, description: options.description, payload: toJsonSchema(options.payload) },
    item: ({ cursor, link, payload, ...fields }) => ({
      _tag: "Event",
      event: {
        ...fields,
        type: eventType,
        payload: encodePayload(payload),
        ...(link === undefined ? {} : { link })
      },
      ...(cursor === undefined ? {} : { cursor })
    })
  }
}

/**
 * Declares the subscription parameters. Throws when `main` is not a required property of the object schema.
 */
export const parameters = <S extends Schema.Codec<object, any>>(options: {
  readonly main: keyof S["Type"] & string
  readonly schema: S
}): Parameters<S["Type"]> => {
  const schema = toJsonSchema(options.schema)
  const required = Array.isArray(schema.required) ? schema.required : []
  if (schema.type !== "object" || !required.includes(options.main)) {
    throw new Error(`The main parameter "${options.main}" must be a required property of an object schema`)
  }
  return { schema: options.schema, spec: { main: options.main, schema } }
}

interface FieldOptions {
  readonly label: string
  readonly required?: boolean
}

export const text = (
  key: string,
  options: FieldOptions & { readonly secretDestination?: boolean }
): ConfigurationField => ({
  _tag: "Text",
  key,
  label: options.label,
  required: options.required ?? true,
  secretDestination: options.secretDestination ?? false
})

export const choice = (
  key: string,
  options: FieldOptions & {
    readonly choices: readonly [string, ...Array<string>]
    readonly secretDestination?: boolean
  }
): ConfigurationField => ({
  _tag: "Choice",
  key,
  label: options.label,
  required: options.required ?? true,
  choices: options.choices,
  secretDestination: options.secretDestination ?? false
})

export const secret = (key: string, options: FieldOptions): ConfigurationField => ({
  _tag: "Secret",
  key,
  label: options.label,
  required: options.required ?? true
})
