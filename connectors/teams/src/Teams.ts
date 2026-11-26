import { Clock, DateTime, Duration, Effect, Option, Ref, Schema, Stream } from "effect"
import { localAppIcon } from "../../shared/localAppIcon.ts"
import { Catalogue, Connector } from "@exangelos/connector-sdk"
import { EventPayload, reconcile, type EventType } from "./Reconcile.ts"
import { localSource, type Source } from "./Source.ts"

const declare = (type: EventType) => Catalogue.event(type, {
  description: "Observed selected-conversation change in the validated native Teams cache representation",
  payload: EventPayload
})
const events = {
  "message.new": declare("message.new"),
  "message.reply": declare("message.reply"),
  "message.edited": declare("message.edited"),
  "reaction.added": declare("reaction.added"),
  "reaction.removed": declare("reaction.removed")
}
const authorize = "Configure Teams with exangelos connector configure teams subscriptionAccess=persisted-cache"
const retired = "This Teams selection is retired. Configure subscriptionAccess=persisted-cache and create a new subscription with the intended Teams conversation ID or message reference"
const pin = /^scope-[a-f0-9]{64}$/
interface Configuration {
  readonly includeMessagePreview: boolean
  readonly account?: string
  readonly cachePath?: string
}
export const make = <R>(source: Source<R>) => Connector.make({
  events: [events["message.new"], events["message.reply"], events["message.edited"], events["reaction.added"], events["reaction.removed"]],
  parameters: Catalogue.parameters({ main: "selection", schema: Schema.Struct({
    selection: Schema.String, scope: Schema.optionalKey(Schema.String)
  }) }),
  configuration: [
    Catalogue.choice("subscriptionAccess", { label: "Allow reading the persisted Teams cache and sharing conversation labels, message authors, times and links, including cached data after logout", choices: ["disabled", "persisted-cache"], required: false }),
    Catalogue.choice("messagePreviews", { label: "Share potentially confidential visible message text as short excerpts in agent wakes, event history, desktop alerts and debug payload logs", choices: ["disabled", "enabled"], required: false }),
    Catalogue.text("account", { label: "Optional cached Teams account, in tenant GUID/user GUID format", required: false }),
    Catalogue.text("cachePath", { label: "Optional absolute Teams IndexedDB cache directory. Leave blank for native macOS discovery", required: false })
  ],
  handlers: Effect.gen(function*() {
    const configured = yield* Ref.make<Configuration | undefined>(undefined)
    return {
      icon: Effect.promise((signal) => localAppIcon(["com.microsoft.teams2", "com.microsoft.teams"], Connector.maxIconBytes, signal)),
      configure: (values) => Effect.gen(function*() {
        yield* Ref.set(configured, undefined)
        if (values.subscriptionAccess === "disabled") return
        if (values.subscriptionAccess !== "persisted-cache") return yield* new Connector.ConfigurationRejected({ reason: authorize })
        if (values.messagePreviews !== undefined && !["disabled", "enabled"].includes(values.messagePreviews)) {
          return yield* new Connector.ConfigurationRejected({ reason: "Use messagePreviews=enabled or messagePreviews=disabled" })
        }
        const account = values.account?.toLowerCase()
        const guid = /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/
        if (account && (account.split("/").length !== 2 || !account.split("/").every((id) => guid.test(id)))) {
          return yield* new Connector.ConfigurationRejected({ reason: "Use tenantGUID/userGUID for the cached Teams account" })
        }
        const cachePath = values.cachePath
        if (cachePath && (!cachePath.startsWith("/") || cachePath.length > 4096 || cachePath.includes("\0"))) {
          return yield* new Connector.ConfigurationRejected({ reason: "Use an absolute Teams IndexedDB directory for cachePath" })
        }
        yield* Ref.set(configured, { includeMessagePreview: values.messagePreviews === "enabled", ...(account && { account }), ...(cachePath && { cachePath }) })
      }),
      describe: ({ selection, scope }) => Effect.gen(function*() {
        const config = yield* Ref.get(configured)
        if (!config) return yield* new Connector.ParametersInvalid({ reason: authorize })
        if (selection === "selected" || /^[a-f0-9]{64}$/.test(selection)) return yield* new Connector.ParametersInvalid({ reason: retired })
        if (scope !== undefined && (pin.test(selection) || !["conversation", "replies"].includes(scope))) {
          return yield* new Connector.ParametersInvalid({ reason: "Use scope=conversation or scope=replies with the original reference" })
        }
        if (!selection.length || selection.length > 4096) return yield* new Connector.ParametersInvalid({ reason: "Supply a Teams conversation ID or message reference" })
        const resolved = yield* source.resolve({ selection, ...(config.account && { account: config.account }), ...(scope && { scope }), ...(config.cachePath && { cachePath: config.cachePath }) })
          .pipe(Effect.mapError((error) => new Connector.ParametersInvalid({ reason: error.reason })))
        const saved = `scope-${resolved.scope}`
        if (pin.test(selection) && selection !== saved) return yield* new Connector.ParametersInvalid({ reason: retired })
        if ((yield* Ref.get(configured)) !== config) return yield* new Connector.ParametersInvalid({ reason: authorize })
        return { subject: `teams:${resolved.scope}`, label: resolved.label, parameters: { selection: saved } }
      }),
      watch: ({ parameters, cursor, wakeWindow }) => Stream.unwrap(Effect.gen(function*() {
        const config = yield* Ref.get(configured)
        if (!config) return yield* new Connector.SourceFailed({ reason: authorize })
        if (!pin.test(parameters.selection) || parameters.scope !== undefined) return yield* new Connector.SourceFailed({ reason: retired })
        const scope = parameters.selection.slice(6)
        const delay = Duration.max(Duration.seconds(1), Duration.min(Duration.seconds(5), wakeWindow))
        return Stream.paginate({ cursor, first: true }, (state) => Effect.gen(function*() {
          if (!state.first) yield* Effect.sleep(delay)
          if ((yield* Ref.get(configured)) !== config) return yield* new Connector.SourceFailed({ reason: authorize })
          const startedAt = state.cursor === undefined ? yield* Clock.currentTimeMillis : undefined
          const snapshot = yield* source.read({ scope, ...config },
            Ref.get(configured).pipe(Effect.map(current => current === config)))
          if (snapshot.scope !== scope || snapshot.includeMessagePreview !== config.includeMessagePreview ||
            (yield* Ref.get(configured)) !== config) return yield* new Connector.SourceFailed({ reason: "Teams selection or consent changed" })
          const result = yield* reconcile(scope, state.cursor, snapshot, startedAt).pipe(
            Effect.mapError(() => new Connector.SourceFailed({
              reason: "Unable to reconcile the Teams snapshot and cursor. Check private state, account and preview policy. A retired cursor or changed policy requires a new subscription"
            }))
          )
          if ((yield* Ref.get(configured)) !== config) return yield* new Connector.SourceFailed({ reason: authorize })
          const items = result.events.map((event, i) => events[event.type].item({
            occurredAt: DateTime.makeUnsafe(event.occurredAt), summary: event.summary,
            payload: event.payload, dedupeKey: event.dedupeKey,
            ...(i === result.events.length - 1 ? { cursor: result.cursor } : {})
          }))
          if (items.length === 0 && (state.first || state.cursor !== result.cursor)) items.push(Connector.cursor(result.cursor))
          return [items, Option.some({ cursor: result.cursor as string | undefined, first: false })] as const
        }).pipe(Effect.mapError((error) => new Connector.SourceFailed({ reason: error.reason }))))
      }))
    }
  })
})
export const connector = make(localSource)
