import { DateTime, Effect, Option } from "effect"
import { Delivery, Lifecycle } from "@exangelos/domain"
import type { Ids, Wake } from "@exangelos/domain"
import { EventRepository } from "../../ports/EventRepository.ts"
import { PluginRepository } from "../../ports/PluginRepository.ts"
import { currentLimits } from "../Limits.ts"
import { SubscriptionSignals } from "../Signals.ts"
import { load } from "./shared.ts"

/** Blocks until the subscription has something to say and returns what its wake would contain. */
export const wait = (request: { readonly id: Ids.SubscriptionId }) =>
  Effect.scoped(Effect.gen(function*() {
    const changes = yield* (yield* SubscriptionSignals).listen(request.id)
    const events = yield* EventRepository
    const plugins = yield* PluginRepository
    while (true) {
      const subscription = yield* load(request.id)
      const pending = yield* events.list(subscription.id, subscription.ackedThrough)
      const plugin = yield* plugins.find(subscription.plugin)
      const now = yield* DateTime.now
      const limits = yield* currentLimits
      const suspension: Option.Option<Wake.Why> = Option.flatMap(
        plugin,
        (plugin) => Lifecycle.suspensionWake(subscription, plugin, Option.none(), now, limits)
      )
      const content = Delivery.waitContent(subscription, pending, suspension)
      if (Option.isSome(content)) return content.value
      yield* changes.next
    }
  }))
