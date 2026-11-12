import { Data, Effect, Layer, Logger, Schema, Stream } from "effect"
import { type Rpc, type RpcGroup, RpcSerialization, RpcServer } from "effect/rpc"
import { PluginProtocol } from "@exangelos/contracts"
import type { Catalogue as Wire, Event, Ids } from "@exangelos/domain"
import type { ConfigurationField, EventType, Parameters } from "./Catalogue.ts"

export class ConfigurationRejected extends Data.TaggedError("ConfigurationRejected")<{ readonly reason: string }> {}

export class ParametersInvalid extends Data.TaggedError("ParametersInvalid")<{ readonly reason: string }> {}

export const { CredentialsRejected, SourceFailed } = PluginProtocol
export type CredentialsRejected = PluginProtocol.CredentialsRejected
export type SourceFailed = PluginProtocol.SourceFailed

export interface WatchRequest<P> {
  readonly parameters: P
  readonly eventTypes: ReadonlyArray<Ids.EventType>
  readonly cursor: string | undefined
}

export interface Handlers<P, R> {
  readonly configure: (values: Wire.ConfigurationValues) => Effect.Effect<void, ConfigurationRejected, R>
  readonly describe: (
    parameters: P
  ) => Effect.Effect<
    { readonly subject: string; readonly label: string; readonly parameters?: P },
    ParametersInvalid,
    R
  >
  readonly watch: (request: WatchRequest<P>) => Stream.Stream<Event.WatchItem, PluginProtocol.WatchError, R>
}

export const end = (reason: string): Event.WatchItem => ({ _tag: "End", reason })

export const cursor = (cursor: string): Event.WatchItem => ({ _tag: "Cursor", cursor })

const missingRequired = (fields: ReadonlyArray<ConfigurationField>, values: Wire.ConfigurationValues) =>
  fields.find((field) => field.required && (values[field.key] ?? "") === "")

const selectTypes = (eventTypes: ReadonlyArray<Ids.EventType>) => {
  if (eventTypes.length === 0) return (item: Event.WatchItem): Event.WatchItem | undefined => item
  const selected = new Set<string>(eventTypes)
  return (item: Event.WatchItem): Event.WatchItem | undefined => {
    if (item._tag !== "Event" || selected.has(item.event.type)) return item
    return item.cursor === undefined ? undefined : cursor(item.cursor)
  }
}

type ParametersOf<Params> = Params extends Parameters<infer P> ? P : never

export const make = <Params extends Parameters<any>, R = never, E = never, RB = never>(definition: {
  readonly events: readonly [EventType<any>, ...Array<EventType<any>>]
  readonly parameters: Params
  readonly configuration: ReadonlyArray<ConfigurationField>
  readonly handlers: Effect.Effect<Handlers<ParametersOf<Params>, R>, E, RB>
}) => {
  const catalogue: Wire.Catalogue = {
    eventTypes: [definition.events[0].spec, ...definition.events.slice(1).map((event) => event.spec)],
    parameters: definition.parameters.spec,
    configuration: definition.configuration
  }
  const decode = Schema.decodeUnknownEffect(definition.parameters.schema)
  const encode = Schema.encodeEffect(definition.parameters.schema)

  const layer = PluginProtocol.PluginProtocol.toLayer(
    Effect.gen(function*() {
      const handlers = yield* definition.handlers
      return PluginProtocol.PluginProtocol.of({
        Handshake: () => Effect.succeed({ protocolVersion: PluginProtocol.version, catalogue }),
        Configure: ({ values }) => {
          const missing = missingRequired(definition.configuration, values)
          if (missing !== undefined) {
            return Effect.succeed({ _tag: "Rejected", reason: `Missing required field: ${missing.key}` } as const)
          }
          return handlers.configure(values).pipe(
            Effect.as({ _tag: "Accepted" } as const),
            Effect.catchTag("ConfigurationRejected", ({ reason }) =>
              Effect.succeed({ _tag: "Rejected", reason } as const))
          )
        },
        Describe: ({ parameters }) =>
          decode(parameters).pipe(
            Effect.mapError((error) => new ParametersInvalid({ reason: error.message })),
            Effect.flatMap((decoded) =>
              handlers.describe(decoded).pipe(
                Effect.flatMap((described) =>
                  encode(described.parameters ?? decoded).pipe(
                    Effect.orDie,
                    Effect.map((normalised) => ({
                      _tag: "Described" as const,
                      parameters: normalised as Wire.Parameters,
                      subject: described.subject,
                      label: described.label
                    }))
                  )
                )
              )
            ),
            Effect.catchTag("ParametersInvalid", ({ reason }) => Effect.succeed({ _tag: "Invalid", reason } as const))
          ),
        Watch: ({ parameters, eventTypes, cursor }) =>
          decode(parameters).pipe(
            Effect.mapError((error) => new SourceFailed({ reason: `Invalid parameters: ${error.message}` })),
            Effect.map((decoded) =>
              handlers.watch({ parameters: decoded, eventTypes, cursor }).pipe(
                Stream.map(selectTypes(eventTypes)),
                Stream.filter((item) => item !== undefined),
                Stream.takeUntil((item) => item._tag === "End")
              )
            ),
            Stream.unwrap
          )
      })
    })
  )
  return { catalogue, layer }
}

type ProtocolHandlers = Rpc.ToHandler<RpcGroup.Rpcs<typeof PluginProtocol.PluginProtocol>>

export const serve = <E, R>(plugin: { readonly layer: Layer.Layer<ProtocolHandlers, E, R> }) =>
  RpcServer.layer(PluginProtocol.PluginProtocol).pipe(
    Layer.provide(plugin.layer),
    Layer.provide(RpcServer.layerProtocolStdio),
    Layer.provide(RpcSerialization.layerNdjson),
    Layer.provide(Layer.succeed(Logger.LogToStderr, true))
  )
