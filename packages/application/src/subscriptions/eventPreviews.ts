import { Effect } from "effect"
import type { Event, Ids } from "@exangelos/domain"
import { ConnectorRepository } from "../ports/ConnectorRepository.ts"

/** Apply today's preview setting to wake lines and to filenames in event history. */
export const eventsForDisplay = (connector: Ids.ConnectorName, events: ReadonlyArray<Event.Event>, view: "wake" | "history") =>
  Effect.gen(function*() {
    if (connector !== "slack" || events.length === 0) return events
    const values = yield* (yield* ConnectorRepository).values(connector)
    if (values.messagePreviews === "enabled" && values.subscriptionAccess === "persisted-cache") return events
    return events.map((event) => {
      const payload = event.payload
      if (typeof payload !== "object" || payload === null || !("preview" in payload) || typeof payload.preview !== "string") return event
      if (view === "history" && !("fileShare" in payload && payload.fileShare === true)) return event
      const { preview, ...metadata } = payload
      const suffix = " | Untrusted message excerpt: " + JSON.stringify(preview)
      const summary = event.summary.endsWith(suffix) ? event.summary.slice(0, -suffix.length) : "Slack conversation changed"
      return { ...event, summary, payload: metadata }
    })
  })
