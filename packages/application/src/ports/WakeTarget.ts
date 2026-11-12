import { Context, Schema } from "effect"
import type { Effect } from "effect"
import type { Session, Wake } from "@exangelos/domain"

export class DeliveryFailed extends Schema.TaggedError<DeliveryFailed>()("DeliveryFailed", {
  reason: Schema.String
}) {}

export class WakeTarget extends Context.Service<WakeTarget, {
  /** Renders the wake text and hands it to the session through its harness. */
  readonly deliver: (session: Session.Session, content: Wake.WakeContent) => Effect.Effect<void, DeliveryFailed>
}>()("@exangelos/application/WakeTarget") {}
