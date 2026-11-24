import { Cause, Context, Deferred, Effect, Layer, Option, Queue, Ref, Stream } from "effect"
import type { Catalogue, Connector as Domain, Event, Ids } from "@exangelos/domain"
import {
  CredentialsRejected,
  IncompatibleProtocol,
  ConnectorCrashed,
  ConnectorRuntime,
  ConnectorStartFailed,
  type ConfigureAnswer,
  type DescribeAnswer,
  type Launch,
  type ConnectorProcess,
  type WatchRequest,
  type SourceFailed
} from "../ports/ConnectorRuntime.ts"

type WatchError = ConnectorCrashed | CredentialsRejected | SourceFailed
type WatchQueue = Queue.Queue<Event.WatchItem, WatchError | Cause.Done>

/** Picks the Watch streams an item or failure reaches, by the request that opened each. */
export type Where = (request: WatchRequest) => boolean

const everyStream: Where = () => true

export interface Script {
  readonly catalogue: Catalogue.Catalogue
  /** How `start` answers; it succeeds when omitted. */
  readonly start?:
    | { readonly _tag: "Fail"; readonly reason: string }
    | { readonly _tag: "Hang" }
    | { readonly _tag: "Incompatible"; readonly version: number; readonly supported: ReadonlyArray<number> }
  /** Accepts every configuration when omitted. */
  readonly configure?: (values: Catalogue.ConfigurationValues) => ConfigureAnswer
  /**
   * When omitted, the subject and label are the parameter the catalogue names as main, and a
   * missing main parameter is invalid.
   */
  readonly describe?: (parameters: Catalogue.Parameters) => DescribeAnswer
  /** The logo each process serves; none when omitted. */
  readonly icon?: Domain.Icon
}

interface Running {
  readonly exited: Deferred.Deferred<ConnectorCrashed>
  readonly streams: Ref.Ref<ReadonlyMap<WatchQueue, WatchRequest>>
}

interface Connector {
  readonly script: Script
  readonly running: ReadonlyArray<Running>
  readonly buffered: ReadonlyArray<{ readonly item: Event.WatchItem; readonly where: Where }>
  readonly launches: ReadonlyArray<Launch>
  readonly watches: ReadonlyArray<WatchRequest>
  readonly configured: ReadonlyArray<Catalogue.ConfigurationValues>
}

export class ConnectorRuntimeFake extends Context.Service<ConnectorRuntimeFake, {
  /** Installs a scripted connector under the name, keeping what was recorded for it. */
  readonly define: (name: Ids.ConnectorName, script: Script) => Effect.Effect<void>
  /**
   * Sends the item to the connector's open Watch streams that `where` picks (all by default), or
   * keeps it for the next such stream that opens. An End item also ends the streams it reaches.
   */
  readonly emit: (name: Ids.ConnectorName, item: Event.WatchItem, where?: Where) => Effect.Effect<void>
  /** Fails the connector's open Watch streams that `where` picks; the process keeps running. */
  readonly fail: (
    name: Ids.ConnectorName,
    error: CredentialsRejected | SourceFailed,
    where?: Where
  ) => Effect.Effect<void>
  /** Kills every running process of the connector: its streams and calls fail and `exited` completes. */
  readonly crash: (name: Ids.ConnectorName, reason: string) => Effect.Effect<void>
  readonly launches: (name: Ids.ConnectorName) => Effect.Effect<ReadonlyArray<Launch>>
  readonly watches: (name: Ids.ConnectorName) => Effect.Effect<ReadonlyArray<WatchRequest>>
  readonly configured: (name: Ids.ConnectorName) => Effect.Effect<ReadonlyArray<Catalogue.ConfigurationValues>>
  /** Open Watch streams across running processes of the connector. */
  readonly openStreams: (name: Ids.ConnectorName) => Effect.Effect<number>
}>()("@exangelos/application/testing/ConnectorRuntimeFake") {}

const describeByMain = (catalogue: Catalogue.Catalogue) => (parameters: Catalogue.Parameters): DescribeAnswer => {
  const main = parameters[catalogue.parameters.main]
  return typeof main === "string" && main.length > 0
    ? { _tag: "Described", parameters, subject: main, label: main }
    : { _tag: "Invalid", reason: `${catalogue.parameters.main} is required` }
}

/** A ConnectorRuntime whose connectors follow scripts, with ConnectorRuntimeFake to drive them. */
export const layerConnectorRuntime: Layer.Layer<ConnectorRuntime | ConnectorRuntimeFake> = Layer.unwrap(
  Effect.gen(function*() {
    const connectors = yield* Ref.make<ReadonlyMap<Ids.ConnectorName, Connector>>(new Map())

    const lookup = (name: Ids.ConnectorName) => Effect.map(Ref.get(connectors), (all) => all.get(name))
    const change = (name: Ids.ConnectorName, f: (connector: Connector) => Connector) =>
      Ref.update(connectors, (all) => {
        const connector = all.get(name)
        return connector === undefined ? all : new Map(all).set(name, f(connector))
      })
    const recorded = <A>(name: Ids.ConnectorName, f: (connector: Connector) => ReadonlyArray<A>) =>
      Effect.map(lookup(name), (connector) => connector === undefined ? [] : f(connector))
    const openQueues = (name: Ids.ConnectorName, where: Where = everyStream) =>
      Effect.flatMap(
        recorded(name, (connector) => connector.running),
        (running) =>
          Effect.map(Effect.forEach(running, (r) => Ref.get(r.streams)), (maps) =>
            maps.flatMap((map) => [...map].filter(([, request]) => where(request)).map(([queue]) => queue)))
      )

    const startProcess = (launch: Launch, connector: Connector) =>
      Effect.gen(function*() {
        const { name } = launch
        const running: Running = { exited: yield* Deferred.make<ConnectorCrashed>(), streams: yield* Ref.make<ReadonlyMap<WatchQueue, WatchRequest>>(new Map()) }
        yield* change(name, (p) => ({ ...p, running: [...p.running, running], launches: [...p.launches, launch] }))
        yield* Effect.addFinalizer(() =>
          Effect.gen(function*() {
            yield* change(name, (p) => ({ ...p, running: p.running.filter((r) => r !== running) }))
            yield* Effect.forEach((yield* Ref.get(running.streams)).keys(), Queue.end, { discard: true })
          })
        )
        const call = <A>(answer: () => A) =>
          Effect.flatMap(Deferred.isDone(running.exited), (done) =>
            done ? Effect.flatMap(Deferred.await(running.exited), Effect.fail) : Effect.sync(answer))
        const process: ConnectorProcess = {
          catalogue: connector.script.catalogue,
          configure: (values) =>
            Effect.tap(
              call(() => connector.script.configure?.(values) ?? { _tag: "Accepted" as const }),
              () => change(name, (p) => ({ ...p, configured: [...p.configured, values] }))
            ),
          describe: (parameters) =>
            call(() => (connector.script.describe ?? describeByMain(connector.script.catalogue))(parameters)),
          icon: call(() => Option.fromNullishOr(connector.script.icon)),
          watch: (request) =>
            Stream.unwrap(Effect.gen(function*() {
              if (yield* Deferred.isDone(running.exited)) {
                return Stream.fail(yield* Deferred.await(running.exited))
              }
              const queue = yield* Queue.unbounded<Event.WatchItem, WatchError | Cause.Done>()
              const buffered = yield* Ref.modify(connectors, (all) => {
                const p = all.get(name)!
                const picked = p.buffered.filter((entry) => entry.where(request))
                const kept = p.buffered.filter((entry) => !entry.where(request))
                return [picked, new Map(all).set(name, { ...p, buffered: kept, watches: [...p.watches, request] })]
              })
              yield* Ref.update(running.streams, (map) => new Map(map).set(queue, request))
              yield* Effect.forEach(buffered, (entry) => deliver(queue, entry.item), { discard: true })
              return Stream.fromQueue(queue).pipe(
                Stream.ensuring(Ref.update(running.streams, (map) => {
                  const next = new Map(map)
                  next.delete(queue)
                  return next
                }))
              )
            })),
          exited: Deferred.await(running.exited)
        }
        return process
      })

    const deliver = (queue: WatchQueue, item: Event.WatchItem) =>
      Effect.andThen(Queue.offer(queue, item), item._tag === "End" ? Queue.end(queue) : Effect.void)

    const runtime = Layer.succeed(ConnectorRuntime, {
      start: (launch) =>
        Effect.gen(function*() {
          const connector = yield* lookup(launch.name)
          if (connector === undefined) {
            return yield* new ConnectorStartFailed({ connector: launch.name, reason: "no such connector" })
          }
          const start = connector.script.start
          if (start?._tag === "Fail") {
            return yield* new ConnectorStartFailed({ connector: launch.name, reason: start.reason })
          }
          if (start?._tag === "Hang") return yield* Effect.never
          if (start?._tag === "Incompatible") {
            return yield* new IncompatibleProtocol({
              connector: launch.name,
              version: start.version,
              supported: start.supported
            })
          }
          return yield* startProcess(launch, connector)
        })
    })

    const fake = Layer.succeed(ConnectorRuntimeFake, {
      define: (name, script) =>
        Ref.update(connectors, (all) => {
          const earlier = all.get(name)
          return new Map(all).set(name, {
            script,
            running: earlier?.running ?? [],
            buffered: earlier?.buffered ?? [],
            launches: earlier?.launches ?? [],
            watches: earlier?.watches ?? [],
            configured: earlier?.configured ?? []
          })
        }),
      emit: (name, item, where = everyStream) =>
        Effect.gen(function*() {
          const queues = yield* openQueues(name, where)
          if (queues.length === 0) {
            return yield* change(name, (p) => ({ ...p, buffered: [...p.buffered, { item, where }] }))
          }
          yield* Effect.forEach(queues, (queue) => deliver(queue, item), { discard: true })
        }),
      fail: (name, error, where) =>
        Effect.flatMap(openQueues(name, where), (queues) => Effect.forEach(queues, (queue) => Queue.fail(queue, error), { discard: true })),
      crash: (name, reason) =>
        Effect.gen(function*() {
          const running = yield* recorded(name, (connector) => connector.running)
          const crashed = new ConnectorCrashed({ connector: name, reason })
          yield* Effect.forEach(running, (r) =>
            Effect.gen(function*() {
              yield* Deferred.succeed(r.exited, crashed)
              yield* Effect.forEach((yield* Ref.get(r.streams)).keys(), (queue) => Queue.fail(queue, crashed), { discard: true })
            }), { discard: true })
          yield* change(name, (p) => ({ ...p, running: [] }))
        }),
      launches: (name) => recorded(name, (connector) => connector.launches),
      watches: (name) => recorded(name, (connector) => connector.watches),
      configured: (name) => recorded(name, (connector) => connector.configured),
      openStreams: (name) => Effect.map(openQueues(name), (queues) => queues.length)
    })

    return Layer.merge(runtime, fake)
  })
)
