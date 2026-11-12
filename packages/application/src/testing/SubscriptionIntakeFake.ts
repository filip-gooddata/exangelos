import { Context, Effect, Layer, Ref } from "effect"
import type { Event, Ids, Plugin } from "@exangelos/domain"
import { SubscriptionIntake, type Verdict } from "../seam/SubscriptionIntake.ts"

export class SubscriptionIntakeFake extends Context.Service<SubscriptionIntakeFake, {
  /** Items ingested per subscription, in order. */
  readonly ingested: (subscription: Ids.SubscriptionId) => Effect.Effect<ReadonlyArray<Event.WatchItem>>
  /** From now on `ingest` answers "stop" for the subscription, as when it reached a limit. */
  readonly stop: (subscription: Ids.SubscriptionId) => Effect.Effect<void>
  /** Plugin records passed to `pluginChanged`, in order. */
  readonly pluginChanges: Effect.Effect<ReadonlyArray<Plugin.Plugin>>
}>()("@exangelos/application/testing/SubscriptionIntakeFake") {}

/** `ingest` answers "stop" for an End item or a stopped subscription, "continue" otherwise. */
export const layerSubscriptionIntake: Layer.Layer<SubscriptionIntake | SubscriptionIntakeFake> = Layer.unwrap(
  Effect.gen(function*() {
    const items = yield* Ref.make<ReadonlyArray<{ readonly subscription: Ids.SubscriptionId; readonly item: Event.WatchItem }>>([])
    const stopped = yield* Ref.make<ReadonlySet<Ids.SubscriptionId>>(new Set())
    const pluginChanges = yield* Ref.make<ReadonlyArray<Plugin.Plugin>>([])
    return Layer.merge(
      Layer.succeed(SubscriptionIntake, {
        ingest: (subscription, item) =>
          Effect.gen(function*() {
            yield* Ref.update(items, (all) => [...all, { subscription, item }])
            const isStopped = (yield* Ref.get(stopped)).has(subscription)
            const verdict: Verdict = isStopped || item._tag === "End" ? "stop" : "continue"
            return verdict
          }),
        pluginChanged: (plugin) => Ref.update(pluginChanges, (all) => [...all, plugin])
      }),
      Layer.succeed(SubscriptionIntakeFake, {
        ingested: (subscription) =>
          Effect.map(Ref.get(items), (all) => all.filter((entry) => entry.subscription === subscription).map((entry) => entry.item)),
        stop: (subscription) => Ref.update(stopped, (all) => new Set(all).add(subscription)),
        pluginChanges: Ref.get(pluginChanges)
      })
    )
  })
)
