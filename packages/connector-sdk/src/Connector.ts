import * as Fs from "node:fs/promises"
import * as Path from "node:path"
import { Data, Duration, Effect, Layer, Logger, Schema, Stream } from "effect"
import { Base64 } from "effect/encoding"
import { type Rpc, type RpcGroup, RpcSerialization, RpcServer } from "effect/rpc"
import { ConnectorProtocol } from "@exangelos/contracts"
import { type Catalogue as Wire, type Event, type Ids, Limits } from "@exangelos/domain"
import type { ConfigurationField, EventType, Parameters } from "./Catalogue.ts"

export class ConfigurationRejected extends Data.TaggedError("ConfigurationRejected")<{ readonly reason: string }> {}

export class ParametersInvalid extends Data.TaggedError("ParametersInvalid")<{ readonly reason: string }> {}

export const { CredentialsRejected, SourceFailed } = ConnectorProtocol
export type CredentialsRejected = ConnectorProtocol.CredentialsRejected
export type SourceFailed = ConnectorProtocol.SourceFailed

export interface WatchRequest<P> {
  readonly parameters: P
  readonly eventTypes: ReadonlyArray<Ids.EventType>
  readonly cursor: string | undefined
  /** The daemon's wake window, or its 5 s default when the daemon sends none. */
  readonly wakeWindow: Duration.Duration
}

/** A logo the connector serves: PNG or SVG bytes. The daemon refuses one over 32 KiB or whose bytes are not its type. */
export interface Icon {
  readonly mediaType: "image/png" | "image/svg+xml"
  readonly bytes: Uint8Array
}

export class IconUnreadable extends Data.TaggedError("IconUnreadable")<{ readonly reason: string }> {}

const mediaTypes: Record<string, Icon["mediaType"]> = { ".png": "image/png", ".svg": "image/svg+xml" }

/** The largest icon the daemon relays; `iconFile` refuses a larger file before reading it. */
export const maxIconBytes = 32 * 1024

const readIconFile = async (path: string, inside?: string): Promise<Icon | string> => {
  const mediaType = mediaTypes[Path.extname(path).toLowerCase()]
  if (mediaType === undefined) return `${path} is not an .svg or .png`
  const real = await Fs.realpath(path)
  if (inside !== undefined && !real.startsWith((await Fs.realpath(inside)) + Path.sep)) return `${path} leads outside the connector`
  const stat = await Fs.stat(real)
  if (!stat.isFile()) return `${path} is not a file`
  if (stat.size > maxIconBytes) return `${path} is ${stat.size} bytes, over the ${maxIconBytes} byte limit`
  return { mediaType, bytes: new Uint8Array(await Fs.readFile(real)) }
}

const iconAt = (path: string, inside?: string): Effect.Effect<Icon, IconUnreadable> =>
  Effect.tryPromise({
    try: () => readIconFile(Path.resolve(path), inside),
    catch: () => new IconUnreadable({ reason: `${path} cannot be read` })
  }).pipe(
    Effect.flatMap((read) => typeof read === "string" ? Effect.fail(new IconUnreadable({ reason: read })) : Effect.succeed(read))
  )

/**
 * Reads an `.svg` or `.png` file (either case) of at most `maxIconBytes` as an icon. A relative path resolves
 * against the working directory, which is the connector's folder.
 */
export const iconFile = (path: string): Effect.Effect<Icon, IconUnreadable> => iconAt(path)

/**
 * The file the manifest `icon` in `directory` names, or none when the manifest names none. The file must stay
 * inside the directory after links are resolved.
 */
export const manifestIconIn = (directory: string): Effect.Effect<Icon | undefined, IconUnreadable> =>
  Effect.gen(function*() {
    const manifest = yield* Effect.tryPromise({
      try: async () => JSON.parse(await Fs.readFile(Path.join(directory, "connector.json"), "utf8")) as unknown,
      catch: () => new IconUnreadable({ reason: "connector.json cannot be read" })
    })
    const declared = typeof manifest === "object" && manifest !== null ? (manifest as { icon?: unknown }).icon : undefined
    if (declared === undefined) return undefined
    if (typeof declared !== "string") return yield* new IconUnreadable({ reason: "the manifest icon is not a path" })
    return yield* iconAt(Path.resolve(directory, declared), directory)
  })

/** The default icon hook: the file the manifest `icon` names in the connector's folder, its working directory. */
export const manifestIcon: Effect.Effect<Icon | undefined, IconUnreadable> = Effect.suspend(() => manifestIconIn(process.cwd()))

export interface Handlers<P, R> {
  readonly configure: (values: Wire.ConfigurationValues) => Effect.Effect<void, ConfigurationRejected, R>
  readonly describe: (
    parameters: P
  ) => Effect.Effect<
    { readonly subject: string; readonly label: string; readonly parameters?: P },
    ParametersInvalid,
    R
  >
  readonly watch: (request: WatchRequest<P>) => Stream.Stream<Event.WatchItem, ConnectorProtocol.WatchError, R>
  /**
   * The connector's logo, or none. The daemon asks once each time the process starts, right after the handshake, without waiting for Configure. Defaults to
   * `manifestIcon`; override it to find the logo at run time, such as in an installed app. A failure is
   * logged and serves no logo.
   */
  readonly icon?: Effect.Effect<Icon | undefined, unknown, R>
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
  const codec = Schema.toCodecJson(definition.parameters.schema)
  const decode = Schema.decodeUnknownEffect(codec)
  const encode = Schema.encodeEffect(codec)

  const layer = ConnectorProtocol.ConnectorProtocol.toLayer(
    Effect.gen(function*() {
      const handlers = yield* definition.handlers
      return ConnectorProtocol.ConnectorProtocol.of({
        Handshake: () => Effect.succeed({ protocolVersion: ConnectorProtocol.version, catalogue }),
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
        Icon: () =>
          (handlers.icon ?? manifestIcon).pipe(
            Effect.map((icon): ConnectorProtocol.IconAnswer =>
              icon === undefined
                ? { _tag: "None" }
                : { _tag: "Served", mediaType: icon.mediaType, data: Base64.encode(icon.bytes) }
            ),
            Effect.catchCause((cause) =>
              Effect.as(Effect.logWarning("Serving no icon", cause), { _tag: "None" } as const)
            )
          ),
        Watch: ({ parameters, eventTypes, cursor, wakeWindow }) =>
          decode(parameters).pipe(
            Effect.mapError((error) => new SourceFailed({ reason: `Invalid parameters: ${error.message}` })),
            Effect.map((decoded) =>
              handlers.watch({
                parameters: decoded,
                eventTypes,
                cursor,
                wakeWindow: wakeWindow ?? Limits.defaults.wakeWindow
              }).pipe(
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

type ProtocolHandlers = Rpc.ToHandler<RpcGroup.Rpcs<typeof ConnectorProtocol.ConnectorProtocol>>

export const serve = <E, R>(connector: { readonly layer: Layer.Layer<ProtocolHandlers, E, R> }) =>
  RpcServer.layer(ConnectorProtocol.ConnectorProtocol).pipe(
    Layer.provide(connector.layer),
    Layer.provide(RpcServer.layerProtocolStdio),
    Layer.provide(RpcSerialization.layerNdjson),
    Layer.provide(Layer.succeed(Logger.LogToStderr, true))
  )
