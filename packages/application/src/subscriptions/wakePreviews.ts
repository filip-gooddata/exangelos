import { Effect } from "effect"
import type { Event, Ids } from "@exangelos/domain"
import { ConnectorRepository } from "../ports/ConnectorRepository.ts"

/** Stored Slack events predate the current preview choice. Apply it again for each wake. */
export const eventsForWake = (connector: Ids.ConnectorName, events: ReadonlyArray<Event.Event>) =>
  Effect.gen(function*() {
    if (connector !== "slack" || events.length === 0) return events
    const values = yield* (yield* ConnectorRepository).values(connector)
    if (values.messagePreviews === "enabled" && values.subscriptionAccess === "persisted-cache") return events
    return events.map((event) => {
      const payload = event.payload
      if (typeof payload !== "object" || payload === null || !("preview" in payload) || typeof payload.preview !== "string") return event
      const suffix = " | Untrusted message excerpt: " + JSON.stringify(payload.preview)
      const summary = event.summary.endsWith(suffix) ? event.summary.slice(0, -suffix.length) : "Slack conversation changed"
      return { ...event, summary }
    })
  })
