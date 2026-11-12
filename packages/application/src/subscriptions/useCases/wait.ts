import { DateTime, Duration, Effect, Option } from "effect"
import { Delivery, Lifecycle } from "@exangelos/domain"
import type { Ids, Session, Wake } from "@exangelos/domain"
import { EventRepository } from "../../ports/EventRepository.ts"
import { PluginRepository } from "../../ports/PluginRepository.ts"
import { currentLimits } from "../Limits.ts"
import { RemovedPlugins } from "../RemovedPlugins.ts"
import { SubscriptionSignals } from "../Signals.ts"
import { load } from "./shared.ts"

/** A plugin outage becomes worth reporting with no change to the subscription, so waits recheck. */
const suspensionRecheck = Duration.minutes(1)

/** Blocks until the subscription has something to say and returns what its wake would contain. */
export const wait = (_actor: Session.Actor, request: { readonly id: Ids.SubscriptionId }) =>
  Effect.scoped(Effect.gen(function*() {
    const changes = yield* (yield* SubscriptionSignals).listen(request.id)
    const events = yield* EventRepository
    const plugins = yield* PluginRepository
    const removed = yield* RemovedPlugins
    while (true) {
      const subscription = yield* load(request.id)
      const pending = yield* events.list(subscription.id, subscription.ackedThrough)
      const plugin = yield* plugins.find(subscription.plugin)
      const now = yield* DateTime.now
      const limits = yield* currentLimits
      const suspension: Option.Option<Wake.Why> = Option.isSome(plugin)
        ? Lifecycle.suspensionWake(subscription, plugin.value, Option.none(), now, limits)
        : Lifecycle.suspensionWakeWhen(subscription, yield* removed.find(subscription.plugin), Option.none(), now, limits)
      const content = Delivery.waitContent(subscription, pending, suspension)
      if (Option.isSome(content)) return content.value
      yield* Effect.race(changes.next, Effect.sleep(suspensionRecheck))
    }
  }))
