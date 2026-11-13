import type { Html, HtmlBuilder } from "foldkit/html"
import type { Request } from "../state/Panel.ts"
import { connectorInitials } from "./Facts.ts"
import { Message, type Model, type Screen } from "./Model.ts"

export type H = HtmlBuilder<Message>
type Child = Html | string

export const go = (screen: Screen) => Message.Navigated({ screen })

export const when = (condition: boolean, render: () => Html): Html => (condition ? render() : null)

export const connectorBadge = (h: H, name: string): Html =>
  h.span([h.Class("badge-connector"), h.AriaHidden(true)], [connectorInitials(name)])

export const pill = (h: H, text: string, tone: "quiet" | "ember" = "quiet"): Html =>
  h.span([h.Class(`pill pill-${tone}`)], [text])

export const count = (h: H, value: number, tone: "quiet" | "ember" = "quiet"): Html =>
  h.span([h.Class(`count count-${tone}`)], [String(value)])

export const mono = (h: H, text: string, extra = ""): Html => h.span([h.Class(`mono ${extra}`.trim())], [text])

export const button = (
  h: H,
  label: string,
  message: Message,
  options: { readonly tone?: "plain" | "primary" | "ember" | "danger"; readonly disabled?: boolean } = {}
): Html =>
  h.button([
    h.Type("button"),
    h.Class(`button button-${options.tone ?? "plain"}`),
    h.Disabled(options.disabled ?? false),
    h.OnClick(message)
  ], [label])

export const ask = (h: H, model: Model, label: string, request: Request, tone: "plain" | "primary" | "ember" | "danger" = "plain") =>
  button(h, label, Message.Requested({ request }), { tone, disabled: model.busy })

export const section = (h: H, title: string, children: ReadonlyArray<Child>, aside?: Html): Html =>
  h.section([h.Class("section")], [
    h.div([h.Class("section-head")], [h.h2([h.Class("section-title")], [title]), aside ?? null]),
    ...children
  ])

/** A label on the left and its value on the right, the value wrapping under itself when long. */
export const fact = (h: H, label: string, value: Child, options: { readonly mono?: boolean } = {}): Html =>
  h.div([h.Class("fact")], [
    h.span([h.Class("fact-label")], [label]),
    h.span([h.Class(options.mono === true ? "fact-value mono" : "fact-value")], [value])
  ])

export const header = (h: H, model: Model, title: string): Html =>
  h.header([h.Class("bar bar-top")], [
    h.button([h.Type("button"), h.Class("back"), h.OnClick(go(backFrom(model.screen)))], ["‹ Back"]),
    h.h1([h.Class("bar-title")], [title]),
    h.span([h.Class("bar-spacer")], [])
  ])

const backFrom = (screen: Screen): Screen => (screen._tag === "Connector" ? { _tag: "Connectors" } : { _tag: "Main" })

const confirmText = (request: Request): string => {
  switch (request._tag) {
    case "Cancel":
      return "Cancel this subscription? It closes for good, and the agent hears no more about its subject."
    case "RemoveConnector":
      return `Remove ${request.name}? You would have to import it again to use it.`
    case "DisableConnector":
      return `Disable ${request.name}? It stops running, and its subscriptions wait until you enable it again.`
    default:
      return "Go ahead?"
  }
}

const confirmLabel = (request: Request): string =>
  request._tag === "Cancel" ? "Cancel subscription" : request._tag === "RemoveConnector" ? "Remove" : "Disable"

/** The refusal or the confirmation that sits above a screen's actions. */
export const notices = (h: H, model: Model): ReadonlyArray<Html> => [
  model.confirming === null ? null : h.div([h.Class("notice notice-confirm"), h.Role("alertdialog")], [
    h.p([], [confirmText(model.confirming)]),
    h.div([h.Class("notice-actions")], [
      button(h, "Keep", Message.Dismissed()),
      button(h, confirmLabel(model.confirming), Message.Confirmed(), { tone: "danger", disabled: model.busy })
    ])
  ]),
  model.notice === null
    ? null
    : h.p([h.Class(`notice notice-${model.notice.tone}`), h.Role(model.notice.tone === "refused" ? "alert" : "status")], [
      model.notice.text
    ])
]
