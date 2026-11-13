import type { Limits, Settings } from "@exangelos/domain"
import { Duration, Effect, Result, Schema } from "effect"
import { Command } from "foldkit"
import type { Update } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { type PanelState, type Refusal, Request } from "../state/Panel.ts"
import { refusalText } from "./Facts.ts"

/** A value the view keeps as it came; the schema only marks its place in the model. */
const opaque = <A>(name: string) => Schema.declare((_: unknown): _ is A => true, { identifier: name })

const PanelStateSchema = opaque<PanelState>("PanelState")
const RequestSchema = opaque<Request>("Request")

export const Screen = Schema.TaggedUnion({
  Main: {},
  Subscription: { id: Schema.String },
  Connectors: {},
  Connector: { name: Schema.String },
  Settings: {}
})
export type Screen = typeof Screen.Type

export const ImportKind = Schema.Literals(["ArchiveFile", "HttpsLink", "Directory", "GitRepository"])
export type ImportKind = typeof ImportKind.Type

export const Notice = Schema.Struct({ tone: Schema.Literals(["refused", "done"]), text: Schema.String })
export type Notice = typeof Notice.Type

export const Model = Schema.Struct({
  state: PanelStateSchema,
  now: Schema.Finite,
  screen: Screen,
  closedOpen: Schema.Boolean,
  acknowledgedOpen: Schema.Boolean,
  ackThrough: Schema.NullOr(Schema.Finite),
  retargeting: Schema.Boolean,
  importing: Schema.NullOr(ImportKind),
  importLocation: Schema.String,
  importRef: Schema.String,
  configuration: Schema.Record(Schema.String, Schema.String),
  settings: Schema.Record(Schema.String, Schema.String),
  confirming: Schema.NullOr(RequestSchema),
  busy: Schema.Boolean,
  notice: Schema.NullOr(Notice)
})
export type Model = typeof Model.Type

export const Message = defineMessageUnion({
  Changed: { state: PanelStateSchema },
  Ticked: { now: Schema.Finite },
  Navigated: { screen: Screen },
  ToggledClosed: {},
  ToggledAcknowledged: {},
  ChoseAckThrough: { number: Schema.Finite },
  ToggledRetarget: {},
  ChoseImport: { kind: Schema.NullOr(ImportKind) },
  EditedImportLocation: { value: Schema.String },
  EditedImportRef: { value: Schema.String },
  EditedConfiguration: { key: Schema.String, value: Schema.String },
  EditedSetting: { key: Schema.String, value: Schema.String },
  SavedSettings: {},
  Requested: { request: RequestSchema },
  Confirmed: {},
  Dismissed: {},
  Performed: { request: RequestSchema },
  Refused: { text: Schema.String }
})
export type Message = typeof Message.Type

export const initial = (state: PanelState, now: number, screen: Screen = { _tag: "Main" }): Model => ({
  state,
  now,
  screen,
  closedOpen: false,
  acknowledgedOpen: false,
  ackThrough: null,
  retargeting: false,
  importing: null,
  importLocation: "",
  importRef: "",
  configuration: {},
  settings: {},
  confirming: null,
  busy: false,
  notice: null
})

const drafts = {
  ackThrough: null,
  retargeting: false,
  importing: null,
  importLocation: "",
  importRef: "",
  configuration: {},
  settings: {},
  confirming: null
} as const

type LimitKey = keyof Limits.Limits

export interface LimitField {
  readonly key: LimitKey
  readonly label: string
  readonly unit: string
  readonly toInput: (limits: Limits.Limits) => number
  readonly fromInput: (value: number) => Limits.Limits[LimitKey]
}

const durationField = (key: Exclude<LimitKey, "backlogCount">, label: string, unit: string, unitMs: number): LimitField => ({
  key,
  label,
  unit,
  toInput: (limits) => Math.round(Duration.toMillis(limits[key]) / unitMs),
  fromInput: (value) => Duration.millis(value * unitMs)
})

/** The default limits as you edit them, each in the unit it is usually thought of in. */
export const limitFields: ReadonlyArray<LimitField> = [
  durationField("wakeWindow", "Wake window after the first event", "seconds", 1_000),
  { key: "backlogCount", label: "Backlog limit by count", unit: "events", toInput: (l) => l.backlogCount, fromInput: (v) => v },
  durationField("backlogAge", "Backlog limit by age", "hours", 3_600_000),
  durationField("lifetime", "Subscription lifetime", "days", 86_400_000),
  durationField("unavailableBeforeWake", "Connector unavailable before the session hears", "minutes", 60_000),
  durationField("maxRetryDelay", "Longest wait between wake attempts", "minutes", 60_000),
  durationField("retention", "Closed subscriptions kept", "days", 86_400_000)
]

export const eventAlertsKey = "eventAlerts"

/** The settings with your edits applied, or the label of the first field that holds no whole number above zero. */
export const editedSettings = (current: Settings.Settings, edits: Readonly<Record<string, string>>): Result.Result<Settings.Settings, string> => {
  let limits: Limits.Limits = current.limits
  for (const field of limitFields) {
    const raw = edits[field.key]
    if (raw === undefined) continue
    const value = Number(raw.trim())
    if (!Number.isInteger(value) || value < 1) return Result.fail(field.label)
    limits = { ...limits, [field.key]: field.fromInput(value) }
  }
  const alerts = edits[eventAlertsKey]
  return Result.succeed({ ...current, eventAlerts: alerts === undefined ? current.eventAlerts : alerts === "on", limits })
}

/** The drafts a finished request used up; every other draft stays as you left it. */
const settled = (request: Request): Partial<Model> => {
  switch (request._tag) {
    case "Ack":
      return { ackThrough: null }
    case "Retarget":
      return { retargeting: false }
    case "ImportConnector":
      return { importing: null, importLocation: "", importRef: "" }
    case "ConfigureConnector":
      return { configuration: {} }
    case "SetSettings":
      return { settings: {} }
    default:
      return {}
  }
}

const needsConfirming = (request: Request): boolean =>
  request._tag === "Cancel" || request._tag === "RemoveConnector" || request._tag === "DisableConnector"

const doneText = (request: Request): string | null => {
  switch (request._tag) {
    case "ImportConnector":
      return "Imported. It stays inert until you enable it."
    case "ConfigureConnector":
    case "SetSettings":
      return "Saved."
    default:
      return null
  }
}

/** The update for a panel whose actions run through `perform`; the view itself never calls the daemon or the host. */
export const makeUpdate = (perform: (request: Request) => Effect.Effect<void, Refusal>) => {
  const Perform = Command.define("Perform", {
    args: { request: RequestSchema },
    messages: [Message.Performed, Message.Refused],
    execute: ({ request }) =>
      perform(request).pipe(
        Effect.as(Message.Performed({ request })),
        Effect.catch((refusal: Refusal) => Effect.succeed(Message.Refused({ text: refusalText(refusal) })))
      )
  })

  const run = (model: Model, request: Request): Update.Return<Model, Message> => ({
    model: { ...model, confirming: null, busy: true, notice: null },
    commands: [Perform({ request })]
  })

  return (model: Model, message: Message): Update.Return<Model, Message> =>
    Message.match<Update.Return<Model, Message>>(message, {
      Changed: ({ state }) => ({ model: { ...model, state } }),
      Ticked: ({ now }) => ({ model: { ...model, now } }),
      Navigated: ({ screen }) => ({ model: { ...model, ...drafts, screen, notice: null, acknowledgedOpen: false } }),
      ToggledClosed: () => ({ model: { ...model, closedOpen: !model.closedOpen } }),
      ToggledAcknowledged: () => ({ model: { ...model, acknowledgedOpen: !model.acknowledgedOpen } }),
      ChoseAckThrough: ({ number }) => ({ model: { ...model, ackThrough: number } }),
      ToggledRetarget: () => ({ model: { ...model, retargeting: !model.retargeting } }),
      ChoseImport: ({ kind }) => ({ model: { ...model, importing: kind, importLocation: "", importRef: "" } }),
      EditedImportLocation: ({ value }) => ({ model: { ...model, importLocation: value } }),
      EditedImportRef: ({ value }) => ({ model: { ...model, importRef: value } }),
      EditedConfiguration: ({ key, value }) => ({
        model: { ...model, configuration: { ...model.configuration, [key]: value } }
      }),
      EditedSetting: ({ key, value }) => ({ model: { ...model, settings: { ...model.settings, [key]: value } } }),
      SavedSettings: () => {
        if (model.state._tag !== "Ready" || Result.isFailure(model.state.settings)) return { model }
        return Result.match(editedSettings(model.state.settings.success, model.settings), {
          onSuccess: (settings) => run(model, Request.SetSettings({ settings })),
          onFailure: (label) => ({
            model: { ...model, notice: { tone: "refused", text: `${label} takes a whole number above zero.` } }
          })
        })
      },
      Requested: ({ request }) =>
        model.busy
          ? { model }
          : needsConfirming(request)
          ? { model: { ...model, confirming: request, notice: null } }
          : run(model, request),
      Confirmed: () => (model.confirming === null || model.busy ? { model } : run(model, model.confirming)),
      Dismissed: () => ({ model: { ...model, confirming: null } }),
      Performed: ({ request }) => {
        const text = doneText(request)
        return {
          model: {
            ...model,
            ...settled(request),
            busy: false,
            notice: text === null ? null : { tone: "done", text },
            screen: request._tag === "RemoveConnector" ? { _tag: "Connectors" } : model.screen
          }
        }
      },
      Refused: ({ text }) => ({ model: { ...model, busy: false, notice: { tone: "refused", text } } })
    })
}
