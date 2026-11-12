import { DateTime, Effect, Option } from "effect"
import { Lifecycle, Subscribe } from "@exangelos/domain"
import type { Catalogue, Ids, Session } from "@exangelos/domain"
import * as NewId from "../../NewId.ts"
import { PluginRepository } from "../../ports/PluginRepository.ts"
import { SubscriptionRepository } from "../../ports/SubscriptionRepository.ts"
import { PluginAccess, PluginNotFound } from "../../seam/PluginAccess.ts"
import { currentLimits } from "../Limits.ts"
import { record, type Target, targetFlag } from "./shared.ts"

export interface SubscribeRequest {
  readonly plugin: Ids.PluginName
  readonly parameters: Catalogue.Parameters
  /** The value of the plugin's main parameter, given without its key. */
  readonly main?: string
  readonly intent: string
  readonly eventTypes?: ReadonlyArray<Ids.EventType>
  readonly maxEvents?: number
  readonly until?: DateTime.Utc
  readonly target: Target
  /** Ids of similar subscriptions the caller has seen and wants a second one beside. */
  readonly similarOk: ReadonlyArray<Ids.SubscriptionId>
}

/** Creates an active subscription after the plugin names its subject, unless a similar one is open. */
export const subscribe = (
  actor: Session.Actor,
  request: SubscribeRequest,
  detected: ReadonlyArray<Session.Session>
) =>
  Effect.gen(function*() {
    yield* Effect.fromResult(Subscribe.checkIntent(request.intent))
    const wakeTarget = yield* Effect.fromResult(Subscribe.wakeTarget(detected, targetFlag(request.target)))
    const described = yield* (yield* PluginAccess).describe(actor, request.plugin, request.parameters)
    const plugin = yield* (yield* PluginRepository).find(request.plugin)
    if (Option.isNone(plugin)) return yield* new PluginNotFound({ plugin: request.plugin })
    const intent = yield* Effect.fromResult(Subscribe.check(plugin.value, request.intent))
    const open = yield* (yield* SubscriptionRepository).list({ plugin: request.plugin })
    yield* Effect.fromResult(Subscribe.similar(
      open,
      { plugin: request.plugin, subject: described.subject, wakeTarget },
      request.similarOk
    ))
    const subscription = Lifecycle.create(
      {
        id: yield* NewId.subscriptionId,
        plugin: request.plugin,
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
  })
