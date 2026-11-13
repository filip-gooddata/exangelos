import { DateTime, Effect, Layer, Option } from "effect"
import { Ids, Lifecycle, Limits } from "@exangelos/domain"
import type { Event, Connector, Session, Subscription } from "@exangelos/domain"
import { ConnectorAccess } from "../../../src/seam/ConnectorAccess.ts"
import { EventRepository } from "../../../src/ports/EventRepository.ts"
import { ConnectorRepository } from "../../../src/ports/ConnectorRepository.ts"
import { SubscriptionRepository } from "../../../src/ports/SubscriptionRepository.ts"
import { WakeRepository } from "../../../src/ports/WakeRepository.ts"
import { layerSubscriptionIntake } from "../../../src/subscriptions/daemon/Intake.ts"
import { connector } from "../../fixtures.ts"
import { layerHarness } from "../harness.ts"

export const layer = Layer.provideMerge(layerSubscriptionIntake, layerHarness)

export const session: Session.Session = { harness: "claude-code", sessionId: "s-1" }

export const github = Ids.ConnectorName.make("github")

let counter = 0

/** Stores the github connector and an active subscription to it, watched, with a wake target unless told otherwise. */
export const seed = (
  overrides: Partial<Lifecycle.NewSubscription> = {},
  connectorRecord: Connector.Connector = connector("github")
) =>
  Effect.gen(function*() {
    const connectors = yield* ConnectorRepository
    yield* connectors.store(connectorRecord)
    const now = yield* DateTime.now
    const subscription = Lifecycle.create({
      id: Ids.SubscriptionId.make(`sub_test${counter++}`),
      connector: github,
      parameters: { repo: "a/b" },
      subject: "a/b",
      label: "a/b",
      intent: "watch the repo",
      wakeTarget: Option.some(session),
      ...overrides
    }, now, Limits.defaults)
    const subscriptions = yield* SubscriptionRepository
    yield* subscriptions.store(subscription)
    const access = yield* ConnectorAccess
    yield* access.watch(subscription.id)
    return subscription
  })

export const reported = (dedupeKey: string, type = "tick"): Event.ReportedEvent => ({
  type: Ids.EventType.make(type),
  occurredAt: DateTime.makeUnsafe(0),
  summary: `event ${dedupeKey}`,
  payload: {},
  dedupeKey
})

export const reload = (subscription: Subscription.Subscription) =>
  Effect.gen(function*() {
    const repository = yield* SubscriptionRepository
    return Option.getOrThrow(yield* repository.find(subscription.id))
  })

export const wakesOf = (subscription: Subscription.Subscription) =>
  Effect.gen(function*() {
    const repository = yield* WakeRepository
    return yield* repository.list(subscription.id)
  })

export const eventsOf = (subscription: Subscription.Subscription) =>
  Effect.gen(function*() {
    const repository = yield* EventRepository
    return yield* repository.list(subscription.id)
  })
