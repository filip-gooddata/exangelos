import { Clock, DateTime, Duration, Effect, Option, Ref, Schema, Stream } from "effect"
import { localAppIcon } from "../../shared/localAppIcon.ts"
import { Catalogue, Connector } from "@exangelos/connector-sdk"
import { observationBudget, observedMillis, resumeWaiting, waitingCursor } from "../../shared/pendingSubject.ts"
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
          return yield* new Connector.ConfigurationRejected({ reason: "Choose an absolute path to the Teams data folder for cachePath" })
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
      watch: ({ parameters, cursor, wakeWindow, createdAt }) => Stream.unwrap(Effect.gen(function*() {
        const config = yield* Ref.get(configured)
        if (!config) return yield* new Connector.SourceFailed({ reason: authorize })
        if (!pin.test(parameters.selection) || parameters.scope !== undefined) return yield* new Connector.SourceFailed({ reason: retired })
        const scope = parameters.selection.slice(6)
        const delay = Duration.max(Duration.seconds(1), Duration.min(Duration.seconds(5), wakeWindow))
        const waiting = resumeWaiting(scope, cursor)
        if (cursor?.startsWith("waiting:") && !waiting) return yield* new Connector.SourceFailed({ reason: "This watch belongs to a different Teams selection or cannot be resumed" })
        const startedAt = createdAt ? DateTime.toEpochMillis(createdAt) : yield* Clock.currentTimeMillis
        return Stream.paginate({ cursor: waiting?.ledger ?? cursor, first: true, acquiring: !!waiting || cursor === undefined,
          elapsed: waiting?.elapsed ?? 0, lastRead: undefined as number | undefined }, (state) => Effect.gen(function*() {
          if (!state.first) yield* Effect.sleep(delay)
          if ((yield* Ref.get(configured)) !== config) return yield* new Connector.SourceFailed({ reason: authorize })
          const snapshot = yield* source.read({ scope, ...config },
            Ref.get(configured).pipe(Effect.map(current => current === config)))
          if (snapshot.scope !== scope || snapshot.includeMessagePreview !== config.includeMessagePreview ||
            (yield* Ref.get(configured)) !== config) return yield* new Connector.SourceFailed({ reason: "Teams selection or consent changed" })
          if (snapshot.threadMismatch) return [[Connector.end("Could not identify one Teams thread for this message. Please check the thread link.")], Option.none()] as const
          if (snapshot.groupMismatch) return [[Connector.end("This link points to a different Teams group. Please check the group and channel link.")], Option.none()] as const
          let input = state.cursor
          if (!input && createdAt && !snapshot.missing) {
            const baseline = yield* reconcile(scope, undefined, { ...snapshot, messages: [] }, startedAt)
            input = baseline.cursor
          }
          const result = yield* reconcile(scope, input, snapshot, startedAt).pipe(
            Effect.mapError(() => new Connector.SourceFailed({
              reason: "Could not resume this Teams watch. Check the selected account and preview setting, then try again."
            }))
          )
          if ((yield* Ref.get(configured)) !== config) return yield* new Connector.SourceFailed({ reason: authorize })
          if (snapshot.missing && (state.acquiring || snapshot.awaitingGroup) && !result.replayedVisible) {
            const now = yield* Clock.currentTimeMillis
            const elapsed = observedMillis(state.elapsed, state.lastRead, now, Duration.toMillis(delay))
            const subject = snapshot.missing
            if (elapsed >= observationBudget) return [[Connector.end(`Couldn't find this ${subject}. Please check the ${subject} ID or link.`)], Option.none()] as const
            const next = waitingCursor(scope, elapsed, result.cursor)
            return [[Connector.pending(`Waiting for this ${subject} to appear.`, next)], Option.some({
              cursor: result.cursor, first: false, acquiring: true, elapsed, lastRead: now
            })] as const
          }
          const items = result.events.map((event, i) => events[event.type].item({
            occurredAt: DateTime.makeUnsafe(event.occurredAt), summary: event.summary,
            payload: event.payload, dedupeKey: event.dedupeKey,
            ...(i === result.events.length - 1 ? { cursor: result.cursor } : {})
          }))
          if (!state.cursor && input && items.length) items.unshift(Connector.cursor(input))
          if (items.length === 0 && (state.acquiring || state.first || state.cursor !== result.cursor)) items.push(Connector.cursor(result.cursor))
          return [items, Option.some({ ...state, cursor: result.cursor, first: false, acquiring: false })] as const
        }).pipe(Effect.mapError((error) => new Connector.SourceFailed({ reason: error.reason }))))
      }))
    }
  })
})
export const connector = make(localSource)
