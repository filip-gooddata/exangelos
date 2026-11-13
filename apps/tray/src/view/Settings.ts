import type { Settings, Subscription } from "@exangelos/domain"
import { Result } from "effect"
import type { Html } from "foldkit/html"
import type { ServiceStatus } from "../daemon/DaemonClient.ts"
import { type PanelState, Request } from "../state/Panel.ts"
import * as Facts from "./Facts.ts"
import { eventAlertsKey, limitFields, Message, type Model } from "./Model.ts"
import { button, fact, header, type H, mono, notices, section } from "./Parts.ts"

type Ready = Extract<PanelState, { _tag: "Ready" }>

/** An on/off switch; with no message it shows its value and cannot be changed. */
const toggle = (h: H, label: string, on: boolean, message: Message | null): Html =>
  h.button([
    h.Type("button"),
    h.Role("switch"),
    h.AriaChecked(on),
    h.AriaLabel(label),
    h.Class(on ? "switch switch-on" : "switch"),
    h.Disabled(message === null),
    ...(message === null ? [] : [h.OnClick(message)])
  ], [h.span([h.Class("switch-knob")], [])])

const daemon = (h: H, state: PanelState): Html => {
  switch (state._tag) {
    case "Loading":
      return section(h, "Daemon", [fact(h, "Status", "Connecting")])
    case "DaemonNotRunning":
      return section(h, "Daemon", [fact(h, "Status", "Not running"), h.p([h.Class("line-quiet")], [state.message])])
    case "Ready":
      return section(h, "Daemon", Result.match(state.status, {
        onFailure: (reason) => [fact(h, "Status", "Running"), h.p([h.Class("load-error")], [`Could not load its details: ${reason}`])],
        onSuccess: (status: ServiceStatus) => [
          fact(h, "Status", "Running"),
          fact(h, "Version", status.version, { mono: true }),
          h.p([h.Class("line-quiet")], [Facts.startMethodText[status.startMethod]])
        ]
      }))
  }
}

const alertsOn = (model: Model, settings: Settings.Settings): boolean => {
  const edited = model.settings[eventAlertsKey]
  return edited === undefined ? settings.eventAlerts : edited === "on"
}

/** Per-subscription alerts are shown, not changed, until the daemon takes a request for them. */
const subscriptionAlerts = (h: H, subscription: Subscription.Subscription): Html =>
  h.div([h.Class("setting-row")], [
    h.div([h.Class("setting-text")], [
      h.p([h.Class("line-main")], [subscription.label]),
      h.p([h.Class("line-quiet")], [mono(h, subscription.id)])
    ]),
    toggle(h, `Event alerts for ${subscription.label}`, subscription.eventAlerts, null)
  ])

const alerts = (h: H, model: Model, state: Ready, settings: Settings.Settings): Html => {
  const on = alertsOn(model, settings)
  const open = Result.getOrElse(Result.map(state.subscriptions, (all) => all.filter(Facts.isOpen)), () => [])
  return section(h, "Event alerts", [
    h.div([h.Class("setting-row")], [
      h.div([h.Class("setting-text")], [
        h.p([h.Class("line-main")], ["Alerts for new events"]),
        h.p([h.Class("line-quiet")], ["Anything that needs you raises an alert either way."])
      ]),
      toggle(h, "Event alerts", on, Message.EditedSetting({ key: eventAlertsKey, value: on ? "off" : "on" }))
    ]),
    open.length === 0 ? null : h.h3([h.Class("subsection-title")], ["Per subscription"]),
    ...open.map((subscription) => subscriptionAlerts(h, subscription))
  ])
}

const limits = (h: H, model: Model, settings: Settings.Settings): Html =>
  section(h, "Default limits", [
    h.p([h.Class("line-quiet")], ["New subscriptions start with these."]),
    ...limitFields.map((field) => {
      const id = `limit-${field.key}`
      return h.div([h.Class("limit-row")], [
        h.label([h.Class("limit-label"), h.For(id)], [field.label]),
        h.span([h.Class("limit-input")], [
          h.input([
            h.Id(id),
            h.Type("number"),
            h.Class("input input-number"),
            h.Min("1"),
            h.Step("1"),
            h.Value(model.settings[field.key] ?? String(field.toInput(settings.limits))),
            h.OnInput((value) => Message.EditedSetting({ key: field.key, value }))
          ]),
          h.span([h.Class("limit-unit")], [field.unit])
        ])
      ])
    })
  ])

const edited = (model: Model): boolean => Object.keys(model.settings).length > 0

export const settings = (h: H, model: Model): ReadonlyArray<Html> => {
  const { state } = model
  const settingsSection = state._tag === "Ready" ? state.settings : null
  return [
    header(h, model, "Settings"),
    h.main([h.Class("body")], [
      ...notices(h, model),
      daemon(h, state),
      ...(state._tag !== "Ready" || settingsSection === null
        ? []
        : Result.match(settingsSection, {
          onFailure: (reason) => [h.p([h.Class("load-error")], [`Could not load the settings: ${reason}`])],
          onSuccess: (current) => [
            alerts(h, model, state, current),
            limits(h, model, current),
            h.div([h.Class("actions")], [
              button(h, "Save", Message.SavedSettings(), { tone: "primary", disabled: model.busy || !edited(model) })
            ])
          ]
        })),
      h.div([h.Class("actions actions-end")], [
        button(h, "Quit Exangelos", Message.Requested({ request: Request.Quit() }), { disabled: model.busy })
      ])
    ])
  ]
}
