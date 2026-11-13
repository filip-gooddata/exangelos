import { DateTime, Effect, Option } from "effect"
import { Lifecycle, Subscribe } from "@exangelos/domain"
import type { Catalogue, Ids, Session } from "@exangelos/domain"
import * as NewId from "../../NewId.ts"
import { ConnectorRepository } from "../../ports/ConnectorRepository.ts"
import { SubscriptionRepository } from "../../ports/SubscriptionRepository.ts"
import { ConnectorAccess, ConnectorNotFound } from "../../seam/ConnectorAccess.ts"
import { currentLimits } from "../Limits.ts"
import { SubscriptionLocks } from "../Locks.ts"
import { record, type Target, targetFlag } from "./shared.ts"

export interface SubscribeRequest {
  readonly connector: Ids.ConnectorName
  readonly parameters: Catalogue.Parameters
  /** The value of the connector's main parameter, given without its key. */
  readonly main?: string
  readonly intent: string
  readonly eventTypes?: ReadonlyArray<Ids.EventType>
  readonly maxEvents?: number
  readonly until?: DateTime.Utc
  readonly target: Target
  /** Ids of similar subscriptions the caller has seen and wants a second one beside. */
  readonly similarOk: ReadonlyArray<Ids.SubscriptionId>
}

/**
 * Creates an active subscription after the connector names its subject, unless a similar one is open.
 * The check and the store run under the creation lock, so two subscribes cannot both miss each other.
 */
export const subscribe = (
  actor: Session.Actor,
  request: SubscribeRequest,
  detected: ReadonlyArray<Session.Session>
) =>
  Effect.gen(function*() {
    yield* Effect.fromResult(Subscribe.checkIntent(request.intent))
    const wakeTarget = yield* Effect.fromResult(Subscribe.wakeTarget(detected, targetFlag(request.target)))
    const described = yield* (yield* ConnectorAccess).describe(actor, request.connector, {
      parameters: request.parameters,
      main: Option.fromNullishOr(request.main)
    })
    const locks = yield* SubscriptionLocks
    return yield* locks.withCreation(Effect.gen(function*() {
      const connector = yield* (yield* ConnectorRepository).find(request.connector)
      if (Option.isNone(connector)) return yield* new ConnectorNotFound({ connector: request.connector })
      const intent = yield* Effect.fromResult(Subscribe.check(connector.value, request.intent))
      const open = yield* (yield* SubscriptionRepository).list({ connector: request.connector })
      yield* Effect.fromResult(Subscribe.similar(
        open,
        { connector: request.connector, subject: described.subject, wakeTarget },
        request.similarOk
      ))
      const subscription = Lifecycle.create(
        {
          id: yield* NewId.subscriptionId,
          connector: request.connector,
          parameters: described.parameters,
          subject: described.subject,
          label: described.label,
          intent,
          wakeTarget,
          ...(request.eventTypes === undefined ? {} : { eventTypes: request.eventTypes }),
          ...(request.until === undefined ? {} : { endAt: request.until }),
          ...(request.maxEvents === undefined ? {} : { maxEvents: request.maxEvents })
        },
        yield* DateTime.now,
        yield* currentLimits
      )
      return yield* record(actor, "create", Option.none(), { subscription, wake: Option.none() })
    }))
  })
