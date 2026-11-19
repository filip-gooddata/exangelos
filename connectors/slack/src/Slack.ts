import { DateTime, Duration, Effect, Option, Ref, Schema, Stream } from "effect"
import { Catalogue, Connector } from "@exangelos/connector-sdk"
import { reconcile, validateObservation, type EventType } from "./Reconcile.ts"
import { decodeRequest, localSource, SourceUnavailable, type Request, type Source } from "./Source.ts"

const declare = (type: EventType) => Catalogue.event(type, {
  description: "A change between delayed persisted Slack snapshots; intermediate changes may be missed",
  payload: Schema.Struct({ count: Schema.Literal(1) })
})
const events = {
  "message.new": declare("message.new"), "thread.reply": declare("thread.reply"),
  "message.edited": declare("message.edited"), "reaction.added": declare("reaction.added"),
  "reaction.removed": declare("reaction.removed")
}
const reason = "Slack private configuration or persisted snapshot is unavailable or inconsistent"
interface Configuration {
  readonly selected?: { readonly request: typeof Request.Type; readonly scope: string }
  readonly discovery?: Readonly<Record<string, string>>
  readonly interval: Duration.Duration
}
export const make = <R>(source: Source<R>) => Connector.make({
  events: [events["message.new"], events["thread.reply"], events["message.edited"], events["reaction.added"], events["reaction.removed"]],
  parameters: Catalogue.parameters({ main: "selection", schema: Schema.Struct({ selection: Schema.String }) }),
  configuration: [
    Catalogue.choice("sourceMode", { label: "Authorize discovery across local Slack caches and use of the matching persisted account, even after logout or access changes (sign-in unverified)", choices: ["persisted-cache", "pinned-cache", "subscription-ids"], secretDestination: true, required: false }),
    Catalogue.secret("conversationSnippet", { label: "Initial selection by literal cached message snippet", required: false }),
    Catalogue.secret("conversationId", { label: "Initial selection by Slack conversation ID or Slack conversation link", required: false }),
    Catalogue.text("cacheRoot", { label: "Optional fallback: absolute IndexedDB folder; otherwise detect macOS Slack locations", required: false }),
    Catalogue.text("selectionRevision", { label: "Optional reset version (default 1): change to clear old selectors and select again; start a new subscription", secretDestination: true, required: false }),
    Catalogue.secret("privateSource", { label: "Legacy fallback only: existing private selection and stable key JSON", required: false }),
    Catalogue.text("pollIntervalMs", { label: "Poll interval in milliseconds (not freshness; staleness is unbounded)", required: false })
  ],
  handlers: Effect.gen(function*() {
    const configured = yield* Ref.make<Configuration | undefined>(undefined)
    const resolve = (configuration: Configuration, selection: string) => Effect.gen(function*() {
      if (selection === "selected" && configuration.selected) return configuration.selected
      if (!configuration.discovery || !source.setup || !/^(?:[CDG][A-Z0-9]{6,30}|scope-[a-f0-9]{64})$/.test(selection)) {
        return yield* new Connector.ParametersInvalid({ reason })
      }
      const request = yield* source.setup({ ...configuration.discovery, subscription: selection }).pipe(
        Effect.mapError((error) => new Connector.ParametersInvalid({ reason: error.reason }))
      )
      const scope = request.expectedScope
      if (scope === undefined || (selection.startsWith("scope-") && selection !== `scope-${scope}`)) {
        return yield* new Connector.ParametersInvalid({ reason })
      }
      return { request, scope }
    })
    return {
      configure: (values) => Effect.gen(function*() {
        yield* Ref.set(configured, undefined)
        const text = values.pollIntervalMs ?? "30000"
        if (!/^[0-9]+$/.test(text)) return yield* new Connector.ConfigurationRejected({ reason })
        const interval = Number(text)
        if (!Number.isSafeInteger(interval) || interval < 1000 || interval > 3600000) {
          return yield* new Connector.ConfigurationRejected({ reason })
        }
        const setupValues = Object.fromEntries(["sourceMode", "conversationSnippet", "conversationId", "cacheRoot", "selectionRevision"]
          .filter((key) => values[key] !== undefined && values[key] !== "")
          .map((key) => [key, values[key]!]))
        if (values.privateSource && Object.keys(setupValues).length > 0) return yield* new Connector.ConfigurationRejected({ reason })
        if (setupValues.sourceMode === "subscription-ids") {
          if (setupValues.conversationSnippet || setupValues.conversationId || !source.setup) {
            return yield* new Connector.ConfigurationRejected({ reason: "Subscription ID mode takes its selector from Subscribe" })
          }
          return yield* Ref.set(configured, { discovery: setupValues, interval: Duration.millis(interval) })
        }
        const request = values.privateSource
          ? yield* decodeRequest(values.privateSource)
          : source.setup !== undefined && (setupValues.sourceMode === "persisted-cache" || setupValues.sourceMode === "pinned-cache")
          ? yield* source.setup(setupValues)
          : yield* new Connector.ConfigurationRejected({ reason: "Choose persisted-cache to authorize Slack cache setup" })
        if (!values.privateSource && request.expectedScope === undefined) return yield* new Connector.ConfigurationRejected({ reason })
        const snapshot = yield* source.read(request)
        if (request.expectedScope !== undefined && snapshot.scope !== request.expectedScope) return yield* new Connector.ConfigurationRejected({ reason })
        yield* validateObservation(snapshot)
        yield* Ref.set(configured, { selected: { request, scope: snapshot.scope }, interval: Duration.millis(interval) })
      }).pipe(Effect.mapError((error) => error instanceof Connector.ConfigurationRejected ? error :
        new Connector.ConfigurationRejected({ reason: error instanceof SourceUnavailable ? error.reason : reason }))),
      describe: ({ selection }) => Effect.gen(function*() {
        const configuration = yield* Ref.get(configured)
        if (!configuration) return yield* new Connector.ParametersInvalid({ reason })
        const { scope } = yield* resolve(configuration, selection)
        if ((yield* Ref.get(configured)) !== configuration) return yield* new Connector.ParametersInvalid({ reason })
        if (selection === "selected") {
          return { subject: "slack:selected", label: "Selected Slack conversations", parameters: { selection } }
        }
        return { subject: `slack:${scope}`, label: "Selected Slack conversation", parameters: { selection: `scope-${scope}` } }
      }),
      watch: ({ parameters, cursor }) => Stream.unwrap(Effect.gen(function*() {
        const configuration = yield* Ref.get(configured)
        if (!configuration || (parameters.selection !== "selected" && !/^scope-[a-f0-9]{64}$/.test(parameters.selection))) {
          return yield* new Connector.SourceFailed({ reason })
        }
        const { request, scope } = yield* resolve(configuration, parameters.selection).pipe(
          Effect.mapError(() => new Connector.SourceFailed({ reason }))
        )
        return Stream.paginate({ cursor, first: true }, (state) => Effect.gen(function*() {
          if (!state.first) yield* Effect.sleep(configuration.interval)
          if ((yield* Ref.get(configured)) !== configuration) return yield* new Connector.SourceFailed({ reason })
          const snapshot = yield* source.read(request)
          if (snapshot.scope !== scope || (yield* Ref.get(configured)) !== configuration) {
            return yield* new Connector.SourceFailed({ reason })
          }
          const result = yield* reconcile(state.cursor, snapshot)
          const items = result.events.map((event, index) => events[event.type].item({
            occurredAt: DateTime.makeUnsafe(event.occurredAt), summary: "Selected Slack conversation changed in a persisted snapshot",
            payload: { count: 1 }, dedupeKey: event.dedupeKey,
            ...(index === result.events.length - 1 ? { cursor: result.cursor } : {})
          }))
          if (items.length === 0 && state.cursor !== result.cursor) items.push(Connector.cursor(result.cursor))
          return [items, Option.some({ cursor: result.cursor as string | undefined, first: false })] as const
        }).pipe(Effect.mapError(() => new Connector.SourceFailed({ reason }))))
      }))
    }
  })
})
export const connector = make(localSource)
