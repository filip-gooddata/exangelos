import { DateTime, Duration, Effect, Option } from "effect"
import { Delivery, Lifecycle } from "@exangelos/domain"
import type { Ids, Session, Wake } from "@exangelos/domain"
import { eventsForWake } from "../wakePreviews.ts"
import { EventRepository } from "../../ports/EventRepository.ts"
import { ConnectorRepository } from "../../ports/ConnectorRepository.ts"
import { currentLimits } from "../Limits.ts"
import { RemovedConnectors } from "../RemovedConnectors.ts"
import { SubscriptionSignals } from "../Signals.ts"
import { load } from "./shared.ts"

/** A connector outage becomes worth reporting with no change to the subscription, so waits recheck. */
const suspensionRecheck = Duration.minutes(1)

/** Blocks until the subscription has something to say and returns what its wake would contain. */
export const wait = (_actor: Session.Actor, request: { readonly id: Ids.SubscriptionId }) =>
  Effect.scoped(Effect.gen(function*() {
    const changes = yield* (yield* SubscriptionSignals).listen(request.id)
    const events = yield* EventRepository
    const connectors = yield* ConnectorRepository
    const removed = yield* RemovedConnectors
    while (true) {
      const subscription = yield* load(request.id)
      const pending = yield* eventsForWake(subscription.connector, yield* events.list(subscription.id, subscription.ackedThrough))
      const connector = yield* connectors.find(subscription.connector)
      const now = yield* DateTime.now
      const limits = yield* currentLimits
      const suspension: Option.Option<Wake.Why> = Option.isSome(connector)
        ? Lifecycle.suspensionWake(subscription, connector.value, Option.none(), now, limits)
        : Lifecycle.suspensionWakeWhen(subscription, yield* removed.find(subscription.connector), Option.none(), now, limits)
      const content = Delivery.waitContent(subscription, pending, suspension)
      if (Option.isSome(content)) return content.value
      yield* Effect.race(changes.next, Effect.sleep(suspensionRecheck))
    }
  }))
