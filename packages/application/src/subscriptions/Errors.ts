import { Schema } from "effect"
import { Ids } from "@exangelos/domain"

export class SubscriptionNotFound extends Schema.TaggedError<SubscriptionNotFound>()("SubscriptionNotFound", {
  id: Ids.SubscriptionId
}) {}
