import type { DaemonContract } from "@exangelos/contracts"
import type { Alert, Catalogue, Ids, Connector, Session, Settings, Subscription } from "@exangelos/domain"
import { Context, Data, type Duration, Effect, Layer, Option, Ref, Result, Schedule, type Scope, Semaphore, Stream, SubscriptionRef } from "effect"
import {
  type CallFailed,
  command,
  DaemonClient,
  type DaemonNotRunning,
  type Detail,
  type Section,
  type ServiceStatus,
  type SessionTitle,
  type Snapshot,
  snapshot
} from "../daemon/DaemonClient.ts"
import { Host, type HostCommandFailed } from "../host/Host.ts"

export type PanelState = Data.TaggedEnum<{
  Loading: {}
  DaemonNotRunning: { readonly message: string }
  Ready: {
    readonly subscriptions: Section<ReadonlyArray<Subscription.Subscription>>
    readonly details: Section<ReadonlyArray<Detail>>
    readonly titles: Section<ReadonlyArray<SessionTitle>>
    readonly connectors: Section<ReadonlyArray<Connector.Status>>
    readonly needsYou: Section<ReadonlyArray<Alert.Alert>>
    readonly settings: Section<Settings.Settings>
    readonly status: Section<ServiceStatus>
  }
}>
export const PanelState = Data.taggedEnum<PanelState>()

export type Request = Data.TaggedEnum<{
  Ack: { readonly id: Ids.SubscriptionId; readonly through: Ids.AckedThrough }
  Pause: { readonly id: Ids.SubscriptionId }
  Resume: { readonly id: Ids.SubscriptionId }
  Retarget: { readonly id: Ids.SubscriptionId; readonly target: DaemonContract.TargetChoice }
  Cancel: { readonly id: Ids.SubscriptionId }
  ImportConnector: { readonly source: DaemonContract.ImportSource }
  EnableConnector: { readonly name: Ids.ConnectorName; readonly digest: string }
  DisableConnector: { readonly name: Ids.ConnectorName }
  RemoveConnector: { readonly name: Ids.ConnectorName }
  ConfigureConnector: { readonly name: Ids.ConnectorName; readonly values: Catalogue.ConfigurationValues }
  SetEventAlerts: { readonly id: Ids.SubscriptionId; readonly eventAlerts: boolean }
  SetSettings: { readonly settings: Settings.Settings }
  Quit: {}
}>
export const Request = Data.taggedEnum<Request>()

/** Why a request did not happen: an error the daemon declares for it, the daemon being absent, a call that failed otherwise, or a host that refused to quit. */
export type Refusal =
  | DaemonContract.TransitionRefused
  | DaemonContract.BacklogOverLimit
  | DaemonContract.SubscriptionNotFound
  | DaemonContract.InvalidRequest
  | DaemonContract.NoWakeTarget
  | DaemonContract.UnknownHarness
  | DaemonContract.ImportFailed
  | DaemonContract.ConnectorNotFound
  | DaemonContract.ConnectorUnavailable
  | DaemonContract.DigestMismatch
  | DaemonContract.ConfigurationInvalid
  | DaemonContract.ConfigurationRejected
  | DaemonContract.HumanRequired
  | DaemonNotRunning
  | CallFailed
  | HostCommandFailed

/** Sends a request to the daemon, or quits through the host. */
export const act = (client: DaemonClient["Service"], quit: Effect.Effect<void, HostCommandFailed>) =>
(request: Request): Effect.Effect<void, Refusal> =>
  Request.$match(request, {
    Ack: ({ id, through }) => command(client.Ack({ id, through })),
    Pause: ({ id }) => command(client.Pause({ id })),
    Resume: ({ id }) => command(client.Resume({ id })),
    Retarget: ({ id, target }) => command(client.Retarget({ id, target })),
    Cancel: ({ id }) => command(client.Cancel({ id })),
    ImportConnector: ({ source }) => command(client.ImportConnector({ source })),
    EnableConnector: ({ digest, name }) => command(client.EnableConnector({ name, digest })),
    DisableConnector: ({ name }) => command(client.DisableConnector({ name })),
    RemoveConnector: ({ name }) => command(client.RemoveConnector({ name })),
    ConfigureConnector: ({ name, values }) => command(client.ConfigureConnector({ name, values })),
    SetEventAlerts: ({ eventAlerts, id }) => command(client.SetEventAlerts({ id, eventAlerts })),
    SetSettings: ({ settings }) => command(client.SetSettings({ settings })),
    Quit: () => quit
  })

export const needsYou = (
  connectors: ReadonlyArray<Connector.Connector>,
  trustAlerts: ReadonlyArray<Alert.Alert>
): ReadonlyArray<Alert.Alert> => [
  ...trustAlerts,
  ...connectors.flatMap((connector): ReadonlyArray<Alert.Alert> => [
    ...(connector.process === "failing" ? [{ _tag: "Failing", connector: connector.name, reason: "it keeps failing" } as const] : []),
    ...(connector.configuration._tag === "Rejected"
      ? [{ _tag: "CredentialsRejected", connector: connector.name, reason: connector.configuration.reason } as const]
      : [])
  ])
]

export interface SessionGroup {
  readonly wakeTarget: Option.Option<Session.Target>
  readonly subscriptions: ReadonlyArray<Subscription.Subscription>
}

/** Groups subscriptions by the session they wake, in first-seen order, with pull-only subscriptions last. */
export const bySession = (subscriptions: ReadonlyArray<Subscription.Subscription>): ReadonlyArray<SessionGroup> => {
  const groups = new Map<string, { wakeTarget: Option.Option<Session.Target>; subscriptions: Array<Subscription.Subscription> }>()
  const pullOnly: Array<Subscription.Subscription> = []
  for (const subscription of subscriptions) {
    const target = subscription.wakeTarget
    if (target === undefined) {
      pullOnly.push(subscription)
      continue
    }
    const key = `${target.harness}\u0000${target.sessionId}`
    const group = groups.get(key) ?? { wakeTarget: Option.some(target), subscriptions: [] }
    group.subscriptions.push(subscription)
    groups.set(key, group)
  }
  const ordered: Array<SessionGroup> = [...groups.values()]
  if (pullOnly.length > 0) ordered.push({ wakeTarget: Option.none(), subscriptions: pullOnly })
  return ordered
}

const actorName = (actor: Session.Actor) => actor._tag === "You" ? "you" : `${actor.session.harness} session`

/** The subscription's state in a few words, with its pending count while it is active or paused. */
export const stateFact = (subscription: Subscription.Subscription): string => {
  const pending = subscription.lastNumber - subscription.ackedThrough
  const { state } = subscription
  switch (state._tag) {
    case "Active":
      return pending > 0 ? `${pending} pending` : "Active"
    case "Paused":
      switch (state.reason._tag) {
        case "BacklogCount":
          return `Paused: backlog reached ${state.reason.limit} pending events`
        case "BacklogAge":
          return `Paused: oldest pending event too old (${pending} pending)`
        case "Actor":
          return `Paused by ${actorName(state.reason.actor)} (${pending} pending)`
      }
    case "Expired":
      return "Expired"
    case "Ended":
      return state.reason._tag === "MaxEvents" ? "Ended after its last event" : `Ended: ${state.reason.reason}`
    case "Cancelled":
      return `Cancelled by ${actorName(state.actor)}`
  }
}

export const fromLoad = <R>(
  load: Effect.Effect<Snapshot, DaemonNotRunning, R>
): Effect.Effect<PanelState, never, R> =>
  load.pipe(
    Effect.map(({ details, connectors, settings, status, subscriptions, titles, trustAlerts }) =>
      PanelState.Ready({
        subscriptions,
        details,
        titles,
        connectors,
        needsYou: Result.flatMap(connectors, (loaded) => Result.map(trustAlerts, (alerts) => needsYou(loaded, alerts))),
        settings,
        status
      })
    ),
    Effect.catchTag("DaemonNotRunning", ({ message }) => Effect.succeed(PanelState.DaemonNotRunning({ message })))
  )

export const attention = (state: PanelState): Option.Option<boolean> =>
  state._tag === "Ready" ? Option.map(Result.getSuccess(state.needsYou), (alerts) => alerts.length > 0) : Option.none()

export class Panel extends Context.Service<Panel, {
  readonly current: Effect.Effect<PanelState>
  readonly changes: Stream.Stream<PanelState>
  readonly refresh: Effect.Effect<void>
  readonly perform: (request: Request) => Effect.Effect<void, Refusal>
}>()("@exangelos/tray/Panel") {}

export interface Options {
  readonly load: Effect.Effect<Snapshot, DaemonNotRunning>
  readonly setAttention: (needsYou: boolean) => Effect.Effect<void, HostCommandFailed>
  readonly act: (request: Request) => Effect.Effect<void, Refusal>
  readonly interval: Duration.Input
}

/** Loads now and then every `interval`. After each load that lists the connectors, tells the host when the needs-you list has turned empty or non-empty; a host that refuses is told again after the next load. `perform` loads again once a request succeeds. */
export const make = ({ act, interval, load, setAttention }: Options): Effect.Effect<Panel["Service"], never, Scope.Scope> =>
  Effect.gen(function*() {
    const state = yield* SubscriptionRef.make<PanelState>(PanelState.Loading())
    const sent = yield* Ref.make(Option.none<boolean>())
    const lock = yield* Semaphore.make(1)
    const refresh = Effect.gen(function*() {
      const next = yield* fromLoad(load)
      yield* SubscriptionRef.set(state, next)
      const needed = attention(next)
      if (Option.isSome(needed) && !Option.contains(yield* Ref.get(sent), needed.value)) {
        yield* setAttention(needed.value).pipe(
          Effect.andThen(Ref.set(sent, Option.some(needed.value))),
          Effect.catchTag("HostCommandFailed", Effect.logWarning)
        )
      }
    }).pipe(lock.withPermits(1))
    yield* Effect.forkScoped(Effect.repeat(refresh, Schedule.spaced(interval)))
    return Panel.of({
      current: SubscriptionRef.get(state),
      changes: SubscriptionRef.changes(state),
      refresh,
      perform: (request) => Effect.andThen(act(request), refresh)
    })
  })

export const layer = (interval: Duration.Input): Layer.Layer<Panel, never, DaemonClient | Host> =>
  Layer.effect(
    Panel,
    Effect.gen(function*() {
      const client = yield* DaemonClient
      const host = yield* Host
      return yield* make({
        interval,
        load: Effect.provideService(snapshot, DaemonClient, client),
        setAttention: host.setAttention,
        act: act(client, host.quit)
      })
    })
  )

const describeSection = <A>(name: string, section: Section<ReadonlyArray<A>>) =>
  Result.match(section, { onSuccess: (items) => `${name} ${items.length}`, onFailure: (message) => `${name} failed (${message})` })

/** Passes once the daemon has answered and the connectors have loaded; the report names every section. */
export const smokeReport = (state: PanelState): { readonly ok: boolean; readonly report: string } =>
  PanelState.$match(state, {
    Loading: () => ({ ok: false, report: "panel still loading" }),
    DaemonNotRunning: ({ message }) => ({ ok: false, report: `daemon not running: ${message}` }),
    Ready: ({ details, needsYou, connectors, subscriptions }) => ({
      ok: Result.isSuccess(connectors),
      report: `panel ready: ${
        [
          describeSection("connectors", connectors),
          describeSection("needs you", needsYou),
          describeSection("subscriptions", subscriptions),
          describeSection("details", details)
        ].join(", ")
      }`
    })
  })
