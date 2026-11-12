import { DateTime } from "effect"
import * as Lifecycle from "./Lifecycle.ts"
import type { Limits } from "./Limits.ts"
import type { Subscription } from "./Subscription.ts"

export type Decision =
  | { readonly _tag: "Keep" }
  | { readonly _tag: "Delete" }
  | { readonly _tag: "Cancel"; readonly subscription: Subscription }

export const decide = (subscription: Subscription, now: DateTime.Utc, limits: Limits): Decision => {
  if (DateTime.isLessThan(now, DateTime.addDuration(subscription.stateSince, limits.retention))) return { _tag: "Keep" }
  if (!Lifecycle.isOpen(subscription)) return { _tag: "Delete" }
  if (subscription.state._tag === "Expired") {
    return {
      _tag: "Cancel",
      subscription: { ...subscription, state: { _tag: "Cancelled", actor: { _tag: "You" } }, stateSince: now }
    }
  }
  return { _tag: "Keep" }
}
