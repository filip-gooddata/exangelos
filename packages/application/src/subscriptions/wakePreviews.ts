import { Effect } from "effect"
import type { Event, Ids } from "@exangelos/domain"
import { ConnectorRepository } from "../ports/ConnectorRepository.ts"

const excerptMarker = " | Untrusted message excerpt: "

/** Stored Slack events predate the current preview choice. Apply it again for each wake. */
export const eventsForWake = (connector: Ids.ConnectorName, events: ReadonlyArray<Event.Event>) =>
  Effect.gen(function*() {
    if (connector !== "slack" || !events.some((event) => event.summary.includes(excerptMarker))) return events
    const values = yield* (yield* ConnectorRepository).values(connector)
    if (values.messagePreviews === "enabled" && values.subscriptionAccess === "persisted-cache") return events
    return events.map((event) => {
      const end = event.summary.indexOf(excerptMarker)
      return end < 0 ? event : { ...event, summary: event.summary.slice(0, end) }
    })
  })
