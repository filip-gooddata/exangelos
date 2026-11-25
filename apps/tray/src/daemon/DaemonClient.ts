import { DaemonContract, SessionHeaders } from "@exangelos/contracts"
import type { Alert, Connector, Session, Settings, Subscription } from "@exangelos/domain"
import { Context, Effect, Layer, Predicate, Result, Schedule, Schema } from "effect"
import { type Rpc, RpcClient, RpcSerialization } from "effect/rpc"
import type { RpcClientError } from "effect/rpc/RpcClientError"
import { Socket } from "effect/socket"

export class DaemonClient extends Context.Service<
  DaemonClient,
  RpcClient.FromGroup<DaemonContract.DaemonContract, RpcClientError>
>()("@exangelos/tray/DaemonClient") {}

const reserved = new Set([SessionHeaders.harnessHeader, SessionHeaders.sessionHeader])

const withoutSession = (headers: ReadonlyArray<[string, string]>) =>
  headers.filter(([name]) => !reserved.has(name.toLowerCase()))

// The default reconnect backoff grows over the whole session up to 5 seconds,
// longer than a snapshot retries a dropped connection.
const protocol = Layer.effect(
  RpcClient.Protocol,
  Effect.map(RpcClient.makeProtocolSocket({ retryPolicy: Schedule.spaced("1 second") }), (socket) =>
    RpcClient.Protocol.of({
      ...socket,
      send: (clientId, request) =>
        socket.send(
          clientId,
          request._tag === "Request" ? { ...request, headers: withoutSession(request.headers) } : request
        )
    }))
).pipe(Layer.provide(RpcSerialization.layerNdjson))

/** Calls the daemon over `Socket.Socket` with no session headers, so the daemon records you as the actor. */
export const layer: Layer.Layer<DaemonClient, never, Socket.Socket> = Layer.effect(
  DaemonClient,
  RpcClient.make(DaemonContract.DaemonContract)
).pipe(Layer.provide(protocol))

export type Section<A> = Result.Result<A, string>

export type Detail = DaemonContract.Details

export type ServiceStatus = Rpc.Success<typeof DaemonContract.ServiceStatus>

export type SessionTitle = DaemonContract.SessionTitle

export interface Snapshot {
  readonly subscriptions: Section<ReadonlyArray<Subscription.Subscription>>
  readonly details: Section<ReadonlyArray<Detail>>
  readonly titles: Section<ReadonlyArray<SessionTitle>>
  readonly connectors: Section<ReadonlyArray<Connector.Status>>
  readonly trustAlerts: Section<ReadonlyArray<Alert.Alert>>
  readonly settings: Section<Settings.Settings>
  readonly status: Section<ServiceStatus>
}

export class DaemonNotRunning extends Schema.TaggedError<DaemonNotRunning>()("DaemonNotRunning", {
  message: Schema.String
}) {}

export class CallFailed extends Schema.TaggedError<CallFailed>()("CallFailed", {
  message: Schema.String
}) {}

const describeDefect = (defect: unknown): string => {
  if (Predicate.hasProperty(defect, "message") && typeof defect.message === "string" && defect.message !== "") {
    return defect.message
  }
  if (Predicate.hasProperty(defect, "_tag") && typeof defect._tag === "string") return defect._tag
  if (Predicate.hasProperty(defect, "name") && typeof defect.name === "string") return defect.name
  return String(defect)
}

const isClientError = (error: unknown): error is RpcClientError => Predicate.isTagged(error, "RpcClientError")

// A connection the daemon closed or that stopped answering fails every call
// in flight on it, and a write that races the close dies with the socket
// error; the client reconnects on its own within about a second.
const isDropped = (error: unknown) =>
  Socket.isSocketError(error) ||
  (isClientError(error) && (error.reason._tag === "SocketCloseError" || error.reason._tag === "SocketReadError"))

const section = <A, E>(
  operation: string,
  call: Effect.Effect<A, E | RpcClientError>
): Effect.Effect<Section<A>, DaemonNotRunning> =>
  call.pipe(
    Effect.catchDefect((defect) => Socket.isSocketError(defect) ? Effect.fail(defect) : Effect.die(defect)),
    Effect.retry({ while: isDropped, schedule: Schedule.exponential("100 millis"), times: 5 }),
    Effect.map(Result.succeed),
    Effect.catch((error) =>
      isClientError(error) && error.reason._tag === "SocketOpenError"
        ? Effect.fail(new DaemonNotRunning({ message: error.message }))
        : Effect.succeed(Result.fail(`${operation}: ${describeDefect(error)}`))
    ),
    Effect.catchDefect((defect) => Effect.succeed(Result.fail(`${operation}: ${describeDefect(defect)}`)))
  )

/** Runs a call for its effect. Keeps the errors the call declares, fails with {@link DaemonNotRunning} when the socket cannot be opened, and turns any other client error or defect into {@link CallFailed}. */
export const command = <A, E>(
  call: Effect.Effect<A, E | RpcClientError>
): Effect.Effect<void, Exclude<E, RpcClientError> | DaemonNotRunning | CallFailed> =>
  call.pipe(
    Effect.asVoid,
    Effect.catchIf(isClientError, (error) =>
      Effect.fail(
        error.reason._tag === "SocketOpenError"
          ? new DaemonNotRunning({ message: error.message })
          : new CallFailed({ message: error.message })
      )),
    Effect.catchDefect((defect) => Effect.fail(new CallFailed({ message: describeDefect(defect) })))
  )

/** Each distinct session the subscriptions wake, in first-seen order. */
export const wokenSessions = (subscriptions: ReadonlyArray<Subscription.Subscription>): ReadonlyArray<Session.Target> => {
  const seen = new Map<string, Session.Target>()
  for (const { wakeTarget } of subscriptions) {
    if (wakeTarget !== undefined) seen.set(`${wakeTarget.harness}\u0000${wakeTarget.sessionId}`, wakeTarget)
  }
  return [...seen.values()]
}

const listed = (client: DaemonClient["Service"]) =>
  Effect.flatMap(section("List", client.List({ all: true })), (subscriptions) =>
    Result.match(subscriptions, {
      onFailure: (message) => Effect.succeed({ subscriptions, details: Result.fail(message), titles: Result.fail(message) }),
      onSuccess: (all) => {
        const sessions = wokenSessions(all)
        return Effect.map(
          Effect.all({
            details: section("Show", Effect.forEach(all, ({ id }) => client.Show({ id }), { concurrency: "unbounded" })),
            titles: sessions.length === 0
              ? Effect.succeed(Result.succeed<ReadonlyArray<SessionTitle>>([]))
              : section("SessionTitles", client.SessionTitles({ sessions }))
          }, { concurrency: "unbounded" }),
          ({ details, titles }) => ({ subscriptions, details, titles })
        )
      }
    }))

/** Loads every subscription, closed ones included, with the details of each, the titles of the sessions they wake, the connectors with their trust alerts, the settings and the service status. A call whose connection drops is retried for about three seconds. A call that fails or that the daemon answers with a defect fails only its own section; the details fail with the first failing `Show`, or with `List`. Fails with {@link DaemonNotRunning} when the socket cannot be opened. */
export const snapshot: Effect.Effect<Snapshot, DaemonNotRunning, DaemonClient> = Effect.flatMap(
  DaemonClient,
  (client) =>
    Effect.map(
      Effect.all({
        listed: listed(client),
        connectors: section("ListConnectors", client.ListConnectors()),
        trustAlerts: section("ListConnectorAlerts", client.ListConnectorAlerts()),
        settings: section("GetSettings", client.GetSettings()),
        status: section("ServiceStatus", client.ServiceStatus())
      }, { concurrency: "unbounded" }),
      ({ listed, ...rest }) => ({ ...listed, ...rest })
    )
)
