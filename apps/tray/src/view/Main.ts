import type { Connector, Subscription } from "@exangelos/domain"
import { Option, Result } from "effect"
import type { Html } from "foldkit/html"
import type { Detail } from "../daemon/DaemonClient.ts"
import { bySession, type PanelState, Request } from "../state/Panel.ts"
import * as Facts from "./Facts.ts"
import { Message, type Model } from "./Model.ts"
import { button, connectorBadge, count, go, type H, iconOf, notices, pill, when } from "./Parts.ts"

type Ready = Extract<PanelState, { _tag: "Ready" }>

export const subscribeCommand = `exangelos subscribe github-pr acme/app#123 --intent "Waiting on checks and review"`

const detailsById = (state: Ready): ReadonlyMap<string, Detail> =>
  new Map(Result.getOrElse(Result.map(state.details, (all) => all.map((d) => [d.subscription.id, d] as const)), () => []))

const titlesOf = (state: Ready): Facts.Titles => Result.getOrElse(Result.map(state.titles, Facts.titlesFrom), () => Facts.noTitles)

const loaded = <A>(section: Result.Result<ReadonlyArray<A>, string>): ReadonlyArray<A> =>
  Result.getOrElse(section, () => [])

const failure = (h: H, what: string, section: Result.Result<unknown, string>): Html =>
  Result.isFailure(section) ? h.p([h.Class("load-error")], [`Could not load ${what}: ${section.failure}`]) : null

const needsYouStrip = (h: H, model: Model, state: Ready): Html => {
  if (Result.isFailure(state.needsYou)) return failure(h, "what needs you", state.needsYou)
  const alerts = state.needsYou.success
  if (alerts.length === 0) return null
  const connectors = loaded(state.connectors)
  const subscriptions = loaded(state.subscriptions)
  return h.section([h.Class("needs-you"), h.AriaLabel("Needs you")], [
    h.div([h.Class("needs-you-head")], [h.h2([], ["Needs you"]), count(h, alerts.length, "ember")]),
    ...alerts.map((alert) => {
      const item = Facts.needsYouItem(model.now, alert, connectors, subscriptions)
      return h.div([h.Class("needs-you-item")], [
        connectorBadge(h, item.connector, iconOf(model, connectors, item.connector)),
        h.div([h.Class("needs-you-text")], [
          h.p([h.Class("line-main")], [item.title]),
          h.p([h.Class("line-quiet")], [item.detail])
        ]),
        button(h, item.action, go({ _tag: "Connector", name: item.connector }), { tone: "ember" })
      ])
    })
  ])
}

const lastEvent = (detail: Detail | undefined) =>
  detail?.events.reduce<Detail["events"][number] | undefined>(
    (newest, event) => (newest === undefined || event.number > newest.number ? event : newest),
    undefined
  )

/** How a row reads at a glance: calm when active, muted when paused or expired, ember when it needs a look. */
export const rowTone = (subscription: Subscription.Subscription, suspended: boolean, retrying: boolean): "calm" | "muted" | "alert" =>
  suspended || retrying ? "alert" : subscription.state._tag === "Active" ? "calm" : "muted"

const row = (
  h: H,
  model: Model,
  subscription: Subscription.Subscription,
  detail: Detail | undefined,
  connectors: ReadonlyArray<Connector.Status>,
  titles: Facts.Titles
): Html => {
  const suspended = Facts.suspendedOn(subscription, connectors)
  const tag = Facts.stateTag(subscription, suspended !== undefined)
  const waiting = Facts.isOpen(subscription) ? Facts.retryingWake(detail) : undefined
  const tone = rowTone(subscription, suspended !== undefined, waiting !== undefined)
  const event = lastEvent(detail)
  const pending = Facts.pending(subscription)
  const facts = [
    Facts.rowFact(model.now, subscription, suspended, titles),
    ...(waiting === undefined ? [] : [Facts.retryFact(model.now, waiting)])
  ].filter((fact): fact is string => fact !== undefined)
  return h.keyed("button")(subscription.id, [
    h.Type("button"),
    h.Class(`row row-${tone}`),
    h.Title(Facts.rowHover(model.now, subscription)),
    h.OnClick(go({ _tag: "Subscription", id: subscription.id }))
  ], [
    connectorBadge(h, subscription.connector, iconOf(model, connectors, subscription.connector)),
    h.span([h.Class("row-body")], [
      h.span([h.Class("row-line")], [
        h.span([h.Class("row-label")], [Facts.rowLabel(subscription)]),
        tag === undefined ? null : pill(h, tag, tone === "alert" ? "ember" : "quiet"),
        h.span([h.Class("row-aside")], [
          event === undefined ? null : h.span([h.Class("time")], [Facts.age(model.now, event.occurredAt)]),
          pending > 0 && Facts.isOpen(subscription) ? count(h, pending) : null
        ])
      ]),
      subscription.label === "" ? null : h.span([h.Class("row-intent")], [subscription.intent]),
      facts.length === 0 ? null : h.span([h.Class("row-fact")], [facts.join(". ")])
    ])
  ])
}

const groups = (h: H, model: Model, state: Ready, open: ReadonlyArray<Subscription.Subscription>): ReadonlyArray<Html> => {
  const details = detailsById(state)
  const connectors = loaded(state.connectors)
  const titles = titlesOf(state)
  return bySession(open).map((group) => {
    const waiting = group.subscriptions.map((s) => Facts.retryingWake(details.get(s.id))).find((w) => w !== undefined)
    const head = Option.match(group.wakeTarget, {
      onNone: () => h.h2([h.Class("group-head")], [
        h.span([h.Class("group-harness")], ["Pull-only"]),
        h.span([h.Class("group-session")], ["No session to wake"])
      ]),
      onSome: (session) => h.h2([h.Class("group-head"), h.Title(Facts.sessionHover(session))], [
        h.span([h.Class("group-harness")], [Facts.harnessName(session.harness)]),
        h.span([h.Class("group-session")], [Facts.sessionTitle(session, titles)]),
        waiting === undefined ? null : pill(h, "Not answering", "ember")
      ])
    })
    return h.section([h.Class("group")], [
      head,
      ...group.subscriptions.map((s) => row(h, model, s, details.get(s.id), connectors, titles))
    ])
  })
}

const closedList = (h: H, model: Model, state: Ready, closed: ReadonlyArray<Subscription.Subscription>): Html => {
  if (closed.length === 0) return null
  const connectors = loaded(state.connectors)
  const titles = titlesOf(state)
  return h.section([h.Class("closed")], [
    h.button([h.Type("button"), h.Class("disclosure"), h.AriaExpanded(model.closedOpen), h.OnClick(Message.ToggledClosed())], [
      h.span([h.Class("chevron")], [model.closedOpen ? "⌄" : "›"]),
      h.span([], ["Closed subscriptions"]),
      h.span([h.Class("disclosure-count")], [String(closed.length)])
    ]),
    ...(model.closedOpen
      ? closed.map((subscription) =>
        h.keyed("button")(subscription.id, [
          h.Type("button"),
          h.Class("row row-closed"),
          h.Title(Facts.rowHover(model.now, subscription)),
          h.OnClick(go({ _tag: "Subscription", id: subscription.id }))
        ], [
          connectorBadge(h, subscription.connector, iconOf(model, connectors, subscription.connector)),
          h.span([h.Class("row-body")], [
            h.span([h.Class("row-line")], [
              h.span([h.Class("row-label")], [Facts.rowLabel(subscription)])
            ]),
            h.span([h.Class("row-fact")], [Facts.stateFact(model.now, subscription, undefined, titles)])
          ])
        ])
      )
      : [])
  ])
}

const emptyState = (h: H): Html =>
  h.section([h.Class("empty")], [
    h.h2([h.Class("empty-title")], ["Nothing to watch yet"]),
    h.p([], [
      "Agents subscribe when they want to hear back about a pull request, a ticket or a file, and each one states its intent. You cannot add one here. Each session shows up as its own group."
    ]),
    h.p([h.Class("empty-label")], ["An agent runs, for example"]),
    h.pre([h.Class("command mono")], [subscribeCommand])
  ])

const connectorAlertCount = (state: PanelState): number =>
  state._tag === "Ready" ? Result.getOrElse(Result.map(state.needsYou, (alerts) => alerts.length), () => 0) : 0

export const footer = (h: H, model: Model): Html => {
  const alerts = connectorAlertCount(model.state)
  const version = model.state._tag === "Ready" && Result.isSuccess(model.state.status) ? model.state.status.success.version : null
  return h.footer([h.Class("bar bar-bottom")], [
    h.button([h.Type("button"), h.Class("link"), h.OnClick(go({ _tag: "Connectors" }))], [
      "Connectors",
      alerts > 0 ? count(h, alerts, "ember") : null
    ]),
    h.button([h.Type("button"), h.Class("link"), h.OnClick(go({ _tag: "Settings" }))], ["Settings"]),
    h.span([h.Class("bar-spacer")], []),
    version === null ? null : h.span([h.Class("version mono")], [version]),
    h.button([h.Type("button"), h.Class("link"), h.OnClick(Message.Requested({ request: Request.Quit() }))], ["Quit"])
  ])
}

const top = (h: H, status: string, running: boolean): Html =>
  h.header([h.Class("bar bar-top")], [
    h.h1([h.Class("bar-title bar-title-start")], ["Exangelos"]),
    h.span([h.Class("bar-spacer")], []),
    h.span([h.Class(running ? "status status-running" : "status")], [status])
  ])

export const main = (h: H, model: Model): ReadonlyArray<Html> => {
  const { state } = model
  switch (state._tag) {
    case "Loading":
      return [top(h, "Connecting", false), h.main([h.Class("body")], [h.p([h.Class("quiet-line")], ["Asking the daemon."])]), footer(h, model)]
    case "DaemonNotRunning":
      return [
        top(h, "Daemon not running", false),
        h.main([h.Class("body")], [
          ...notices(h, model),
          h.section([h.Class("empty")], [
            h.h2([h.Class("empty-title")], ["The daemon is not running."]),
            h.p([], [state.message]),
            h.p([], ["It starts by itself when an agent or the CLI needs it."])
          ])
        ]),
        footer(h, model)
      ]
    case "Ready": {
      const all = loaded(state.subscriptions)
      const open = all.filter(Facts.isOpen)
      const closed = all.filter((s) => !Facts.isOpen(s))
      return [
        top(h, "Daemon running", true),
        h.main([h.Class("body")], [
          ...notices(h, model),
          needsYouStrip(h, model, state),
          failure(h, "subscriptions", state.subscriptions),
          failure(h, "the subscriptions' events and wakes", state.details),
          ...(Result.isSuccess(state.subscriptions) && open.length === 0 ? [emptyState(h)] : groups(h, model, state, open)),
          closedList(h, model, state, closed)
        ]),
        footer(h, model)
      ]
    }
  }
}

export { when }
