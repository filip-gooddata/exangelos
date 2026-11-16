import { DateTime, Duration, Effect, Option, Ref, Schema, Stream } from "effect"
import { Catalogue, Connector } from "@exangelos/connector-sdk"
import { reconcile, type EventType } from "./Reconcile.ts"
import { localSource, type Source } from "./Source.ts"

const declare = (type: EventType) => Catalogue.event(type, {
  description: "Observed selected-conversation change in the validated native Teams cache representation",
  payload: Schema.Struct({ count: Schema.Literal(1), source: Schema.Literal("native-cache") })
})
const events = {
  "message.new": declare("message.new"),
  "message.reply": declare("message.reply"),
  "message.edited": declare("message.edited"),
  "reaction.added": declare("reaction.added"),
  "reaction.removed": declare("reaction.removed")
}
const reason = "Teams private selection is unavailable or does not match this subscription"
export const make = <R>(source: Source<R>) => Connector.make({
  events: [events["message.new"], events["message.reply"], events["message.edited"], events["reaction.added"], events["reaction.removed"]],
  parameters: Catalogue.parameters({ main: "selection", schema: Schema.Struct({ selection: Schema.String }) }),
  configuration: [
    Catalogue.secret("selectionToken", { label: "Fresh non-sensitive marker posted once in the intended Teams conversation (12–128 letters, digits, - or _; retained by host)" }),
    Catalogue.text("cachePath", { label: "Optional absolute Teams cache directory (fallback; stored by host). Blank discovers native macOS caches", required: false })
  ],
  handlers: Effect.gen(function*() {
    const configured = yield* Ref.make<string | undefined>(undefined)
    return {
      configure: (values) => Effect.gen(function*() {
        yield* Ref.set(configured, undefined)
        const selectionToken = values.selectionToken ?? ""
        const cachePath = values.cachePath || undefined
        if (!/^[A-Za-z0-9_-]{12,128}$/.test(selectionToken) ||
          (cachePath !== undefined && (cachePath.length > 4096 || !cachePath.startsWith("/") || cachePath.includes("\0")))) {
          return yield* new Connector.ConfigurationRejected({ reason })
        }
        const snapshot = yield* (source.configure ? source.configure({ selectionToken, ...(cachePath ? { cachePath } : {}) }) : source.read)
          .pipe(Effect.mapError(() => new Connector.ConfigurationRejected({ reason })))
        yield* Ref.set(configured, snapshot.scope)
      }),
      describe: ({ selection }) => Effect.gen(function*() {
        const scope = yield* Ref.get(configured)
        if (scope === undefined || (selection !== "selected" && selection !== scope)) {
          return yield* new Connector.ParametersInvalid({ reason })
        }
        return { subject: `teams:${scope}`, label: "Selected Teams cache conversation", parameters: { selection: scope } }
      }),
      watch: ({ parameters, cursor, wakeWindow }) => Stream.unwrap(Effect.gen(function*() {
        const scope = yield* Ref.get(configured)
        if (scope === undefined || parameters.selection !== scope) return yield* new Connector.SourceFailed({ reason })
        const delay = Duration.max(Duration.seconds(1), Duration.min(Duration.seconds(5), wakeWindow))
        return Stream.paginate({ cursor, first: true }, (state) => Effect.gen(function*() {
          if (!state.first) yield* Effect.sleep(delay)
          if ((yield* Ref.get(configured)) !== scope) return yield* new Connector.SourceFailed({ reason })
          const snapshot = yield* source.read
          const result = yield* reconcile(scope, state.cursor, snapshot)
          const items = result.events.map((event, i) => events[event.type].item({
            occurredAt: DateTime.makeUnsafe(event.occurredAt), summary: "Selected Teams conversation changed",
            payload: { count: 1, source: "native-cache" }, dedupeKey: event.dedupeKey,
            ...(i === result.events.length - 1 ? { cursor: result.cursor } : {})
          }))
          if (items.length === 0 && state.cursor !== result.cursor) items.push(Connector.cursor(result.cursor))
          return [items, Option.some({ cursor: result.cursor as string | undefined, first: false })] as const
        }).pipe(Effect.mapError(() => new Connector.SourceFailed({ reason }))))
      }))
    }
  })
})
export const connector = make(localSource)
