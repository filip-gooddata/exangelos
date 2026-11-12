import { Cause, Context, Deferred, Effect, Layer, Queue, Ref, Stream } from "effect"
import type { Catalogue, Event, Ids } from "@exangelos/domain"
import {
  CredentialsRejected,
  IncompatibleProtocol,
  PluginCrashed,
  PluginRuntime,
  PluginStartFailed,
  type ConfigureAnswer,
  type DescribeAnswer,
  type Launch,
  type PluginProcess,
  type WatchRequest,
  type SourceFailed
} from "../ports/PluginRuntime.ts"

type WatchError = PluginCrashed | CredentialsRejected | SourceFailed
type WatchQueue = Queue.Queue<Event.WatchItem, WatchError | Cause.Done>

export interface Script {
  readonly catalogue: Catalogue.Catalogue
  /** How `start` answers; it succeeds when omitted. */
  readonly start?:
    | { readonly _tag: "Fail"; readonly reason: string }
    | { readonly _tag: "Incompatible"; readonly version: number; readonly supported: ReadonlyArray<number> }
  /** Accepts every configuration when omitted. */
  readonly configure?: (values: Catalogue.ConfigurationValues) => ConfigureAnswer
  /**
   * When omitted, the subject and label are the parameter the catalogue names as main, and a
   * missing main parameter is invalid.
   */
  readonly describe?: (parameters: Catalogue.Parameters) => DescribeAnswer
}

interface Running {
  readonly exited: Deferred.Deferred<PluginCrashed>
  readonly streams: Ref.Ref<ReadonlySet<WatchQueue>>
}

interface Plugin {
  readonly script: Script
  readonly running: ReadonlyArray<Running>
  readonly buffered: ReadonlyArray<Event.WatchItem>
  readonly launches: ReadonlyArray<Launch>
  readonly watches: ReadonlyArray<WatchRequest>
  readonly configured: ReadonlyArray<Catalogue.ConfigurationValues>
}

export class PluginRuntimeFake extends Context.Service<PluginRuntimeFake, {
  /** Installs a scripted plugin under the name, keeping what was recorded for it. */
  readonly define: (name: Ids.PluginName, script: Script) => Effect.Effect<void>
  /**
   * Sends the item to every open Watch stream of the plugin, or keeps it for the next stream that
   * opens. An End item also ends the streams it reaches.
   */
  readonly emit: (name: Ids.PluginName, item: Event.WatchItem) => Effect.Effect<void>
  /** Fails every open Watch stream of the plugin with the error; the process keeps running. */
  readonly fail: (name: Ids.PluginName, error: CredentialsRejected | SourceFailed) => Effect.Effect<void>
  /** Kills every running process of the plugin: its streams and calls fail and `exited` completes. */
  readonly crash: (name: Ids.PluginName, reason: string) => Effect.Effect<void>
  readonly launches: (name: Ids.PluginName) => Effect.Effect<ReadonlyArray<Launch>>
  readonly watches: (name: Ids.PluginName) => Effect.Effect<ReadonlyArray<WatchRequest>>
  readonly configured: (name: Ids.PluginName) => Effect.Effect<ReadonlyArray<Catalogue.ConfigurationValues>>
  /** Open Watch streams across running processes of the plugin. */
  readonly openStreams: (name: Ids.PluginName) => Effect.Effect<number>
}>()("@exangelos/application/testing/PluginRuntimeFake") {}

const describeByMain = (catalogue: Catalogue.Catalogue) => (parameters: Catalogue.Parameters): DescribeAnswer => {
  const main = parameters[catalogue.parameters.main]
  return typeof main === "string" && main.length > 0
    ? { _tag: "Described", parameters, subject: main, label: main }
    : { _tag: "Invalid", reason: `${catalogue.parameters.main} is required` }
}

/** A PluginRuntime whose plugins follow scripts, with PluginRuntimeFake to drive them. */
export const layerPluginRuntime: Layer.Layer<PluginRuntime | PluginRuntimeFake> = Layer.unwrap(
  Effect.gen(function*() {
    const plugins = yield* Ref.make<ReadonlyMap<Ids.PluginName, Plugin>>(new Map())

    const lookup = (name: Ids.PluginName) => Effect.map(Ref.get(plugins), (all) => all.get(name))
    const change = (name: Ids.PluginName, f: (plugin: Plugin) => Plugin) =>
      Ref.update(plugins, (all) => {
        const plugin = all.get(name)
        return plugin === undefined ? all : new Map(all).set(name, f(plugin))
      })
    const recorded = <A>(name: Ids.PluginName, f: (plugin: Plugin) => ReadonlyArray<A>) =>
      Effect.map(lookup(name), (plugin) => plugin === undefined ? [] : f(plugin))
    const openQueues = (name: Ids.PluginName) =>
      Effect.flatMap(
        recorded(name, (plugin) => plugin.running),
        (running) => Effect.map(Effect.forEach(running, (r) => Ref.get(r.streams)), (sets) => sets.flatMap((set) => [...set]))
      )

    const startProcess = (launch: Launch, plugin: Plugin) =>
      Effect.gen(function*() {
        const { name } = launch
        const running: Running = { exited: yield* Deferred.make<PluginCrashed>(), streams: yield* Ref.make<ReadonlySet<WatchQueue>>(new Set()) }
        yield* change(name, (p) => ({ ...p, running: [...p.running, running], launches: [...p.launches, launch] }))
        yield* Effect.addFinalizer(() =>
          Effect.gen(function*() {
            yield* change(name, (p) => ({ ...p, running: p.running.filter((r) => r !== running) }))
            yield* Effect.forEach(yield* Ref.get(running.streams), Queue.end, { discard: true })
          })
        )
        const call = <A>(answer: () => A) =>
          Effect.flatMap(Deferred.isDone(running.exited), (done) =>
            done ? Effect.flatMap(Deferred.await(running.exited), Effect.fail) : Effect.sync(answer))
        const process: PluginProcess = {
          catalogue: plugin.script.catalogue,
          configure: (values) =>
            Effect.tap(
              call(() => plugin.script.configure?.(values) ?? { _tag: "Accepted" as const }),
              () => change(name, (p) => ({ ...p, configured: [...p.configured, values] }))
            ),
          describe: (parameters) =>
            call(() => (plugin.script.describe ?? describeByMain(plugin.script.catalogue))(parameters)),
          watch: (request) =>
            Stream.unwrap(Effect.gen(function*() {
              if (yield* Deferred.isDone(running.exited)) {
                return Stream.fail(yield* Deferred.await(running.exited))
              }
              const queue = yield* Queue.unbounded<Event.WatchItem, WatchError | Cause.Done>()
              const buffered = yield* Ref.modify(plugins, (all) => {
                const p = all.get(name)!
                return [p.buffered, new Map(all).set(name, { ...p, buffered: [], watches: [...p.watches, request] })]
              })
              yield* Ref.update(running.streams, (set) => new Set(set).add(queue))
              yield* Effect.forEach(buffered, (item) => deliver(queue, item), { discard: true })
              return Stream.fromQueue(queue).pipe(
                Stream.ensuring(Ref.update(running.streams, (set) => {
                  const next = new Set(set)
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

    const runtime = Layer.succeed(PluginRuntime, {
      start: (launch) =>
        Effect.gen(function*() {
          const plugin = yield* lookup(launch.name)
          if (plugin === undefined) {
            return yield* new PluginStartFailed({ plugin: launch.name, reason: "no such plugin" })
          }
          const start = plugin.script.start
          if (start?._tag === "Fail") {
            return yield* new PluginStartFailed({ plugin: launch.name, reason: start.reason })
          }
          if (start?._tag === "Incompatible") {
            return yield* new IncompatibleProtocol({
              plugin: launch.name,
              version: start.version,
              supported: start.supported
            })
          }
          return yield* startProcess(launch, plugin)
        })
    })

    const fake = Layer.succeed(PluginRuntimeFake, {
      define: (name, script) =>
        Ref.update(plugins, (all) => {
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
      emit: (name, item) =>
        Effect.gen(function*() {
          const queues = yield* openQueues(name)
          if (queues.length === 0) {
            return yield* change(name, (p) => ({ ...p, buffered: [...p.buffered, item] }))
          }
          yield* Effect.forEach(queues, (queue) => deliver(queue, item), { discard: true })
        }),
      fail: (name, error) =>
        Effect.flatMap(openQueues(name), (queues) => Effect.forEach(queues, (queue) => Queue.fail(queue, error), { discard: true })),
      crash: (name, reason) =>
        Effect.gen(function*() {
          const running = yield* recorded(name, (plugin) => plugin.running)
          const crashed = new PluginCrashed({ plugin: name, reason })
          yield* Effect.forEach(running, (r) =>
            Effect.gen(function*() {
              yield* Deferred.succeed(r.exited, crashed)
              yield* Effect.forEach(yield* Ref.get(r.streams), (queue) => Queue.fail(queue, crashed), { discard: true })
            }), { discard: true })
          yield* change(name, (p) => ({ ...p, running: [] }))
        }),
      launches: (name) => recorded(name, (plugin) => plugin.launches),
      watches: (name) => recorded(name, (plugin) => plugin.watches),
      configured: (name) => recorded(name, (plugin) => plugin.configured),
      openStreams: (name) => Effect.map(openQueues(name), (queues) => queues.length)
    })

    return Layer.merge(runtime, fake)
  })
)
