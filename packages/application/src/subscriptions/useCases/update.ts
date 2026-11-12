import { DateTime, Effect, Option } from "effect"
import { Subscribe } from "@exangelos/domain"
import type { Catalogue, Ids, Session } from "@exangelos/domain"
import { SubscriptionRepository } from "../../ports/SubscriptionRepository.ts"
import { PluginAccess } from "../../seam/PluginAccess.ts"
import { currentLimits } from "../Limits.ts"
import { load, record } from "./shared.ts"

export interface UpdateRequest {
  readonly id: Ids.SubscriptionId
  readonly intent?: string
  readonly eventTypes?: ReadonlyArray<Ids.EventType>
  readonly maxEvents?: number
  readonly until?: DateTime.Utc
  readonly parameters?: Catalogue.Parameters
}

/** Changes what a subscription selects or how long it runs; the plugin must still name the same subject. */
export const update = (actor: Session.Actor, request: UpdateRequest) =>
  Effect.gen(function*() {
    const subscription = yield* load(request.id)
    const described = yield* (yield* PluginAccess).describe(
      actor,
      subscription.plugin,
      request.parameters ?? subscription.parameters
    )
    const changes = yield* (yield* SubscriptionRepository).changes(subscription.id)
    const lastStart = changes.findLast((change) => change.kind === "create" || change.kind === "resume")?.at ??
      subscription.createdAt
    const step = yield* Effect.fromResult(Subscribe.update(
      subscription,
      {
        ...(request.intent === undefined ? {} : { intent: request.intent }),
        ...(request.eventTypes === undefined ? {} : { eventTypes: request.eventTypes }),
        ...(request.maxEvents === undefined ? {} : { maxEvents: request.maxEvents }),
        ...(request.until === undefined ? {} : { until: request.until }),
        ...(request.parameters === undefined ? {} : { parameters: described.parameters, label: described.label })
      },
      { reportedSubject: described.subject, lastStart, now: yield* DateTime.now, limits: yield* currentLimits }
    ))
    return yield* record(actor, "update", Option.some(subscription), step)
  })
