import { Effect, Option } from "effect"
import { Intake } from "@exangelos/domain"
import type { Ids, Session } from "@exangelos/domain"
import { load, record } from "./shared.ts"

/** Marks the events up to `through` as handled; never moves back and never resumes. */
export const acknowledge = (
  actor: Session.Actor,
  request: { readonly id: Ids.SubscriptionId; readonly through: Ids.AckedThrough }
) =>
  Effect.gen(function*() {
    const subscription = yield* load(request.id)
    const acked = Intake.acknowledge(subscription, request.through)
    return yield* record(
      actor,
      "ack",
      Option.some(subscription),
      { subscription: acked, wake: Option.none() },
      `through ${acked.ackedThrough}`
    )
  })
