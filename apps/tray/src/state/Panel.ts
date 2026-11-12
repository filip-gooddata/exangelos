import type { Alert, Plugin, Subscription } from "@exangelos/domain"
import { Context, Data, type Duration, Effect, Layer, Option, Ref, Schedule, type Scope, Semaphore, Stream, SubscriptionRef } from "effect"
import { DaemonClient, type DaemonNotRunning, type DaemonUnreachable, type Snapshot, snapshot } from "../daemon/DaemonClient.ts"
import { Host, type HostCommandFailed } from "../host/Host.ts"

export type PanelState = Data.TaggedEnum<{
  Loading: {}
  DaemonNotRunning: { readonly message: string }
  DaemonUnreachable: { readonly message: string }
  Ready: {
    readonly subscriptions: ReadonlyArray<Subscription.Subscription>
    readonly plugins: ReadonlyArray<Plugin.Plugin>
    readonly needsYou: ReadonlyArray<Alert.Alert>
  }
}>
export const PanelState = Data.taggedEnum<PanelState>()

export const needsYou = (plugins: ReadonlyArray<Plugin.Plugin>): ReadonlyArray<Alert.Alert> =>
  plugins.flatMap((plugin): ReadonlyArray<Alert.Alert> => {
    const alerts: Array<Alert.Alert> = []
    if (plugin.trust === "inert") {
      alerts.push(
        plugin.origin._tag === "Official"
          ? { _tag: "DigestMismatch", plugin: plugin.name }
          : { _tag: "WaitsForEnable", plugin: plugin.name }
      )
    }
    if (plugin.process === "failing") alerts.push({ _tag: "Failing", plugin: plugin.name, reason: "it keeps failing" })
    if (plugin.configuration._tag === "Rejected") {
      alerts.push({ _tag: "CredentialsRejected", plugin: plugin.name, reason: plugin.configuration.reason })
    }
    return alerts
  })

export const fromLoad = <R>(
  load: Effect.Effect<Snapshot, DaemonNotRunning | DaemonUnreachable, R>
): Effect.Effect<PanelState, never, R> =>
  load.pipe(
    Effect.map(({ plugins, subscriptions }) => PanelState.Ready({ subscriptions, plugins, needsYou: needsYou(plugins) })),
    Effect.catchTags({
      DaemonNotRunning: ({ message }) => Effect.succeed(PanelState.DaemonNotRunning({ message })),
      DaemonUnreachable: ({ message }) => Effect.succeed(PanelState.DaemonUnreachable({ message }))
    })
  )

export const attention = (state: PanelState): Option.Option<boolean> =>
  state._tag === "Ready" ? Option.some(state.needsYou.length > 0) : Option.none()

export class Panel extends Context.Service<Panel, {
  readonly current: Effect.Effect<PanelState>
  readonly changes: Stream.Stream<PanelState>
  readonly refresh: Effect.Effect<void>
}>()("@exangelos/tray/Panel") {}

export interface Options {
  readonly load: Effect.Effect<Snapshot, DaemonNotRunning | DaemonUnreachable>
  readonly setAttention: (needsYou: boolean) => Effect.Effect<void, HostCommandFailed>
  readonly interval: Duration.Input
}

/** Loads now and then every `interval`. After each load that reaches the daemon, tells the host when the needs-you list has turned empty or non-empty; a host that refuses is told again after the next load. */
export const make = ({ interval, load, setAttention }: Options): Effect.Effect<Panel["Service"], never, Scope.Scope> =>
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
    return Panel.of({ current: SubscriptionRef.get(state), changes: SubscriptionRef.changes(state), refresh })
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
        setAttention: host.setAttention
      })
    })
  )
