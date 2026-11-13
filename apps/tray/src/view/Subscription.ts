import type { DaemonContract } from "@exangelos/contracts"
import type { Event, Session, Subscription, Wake } from "@exangelos/domain"
import { DateTime, Result } from "effect"
import type { Html } from "foldkit/html"
import type { Detail } from "../daemon/DaemonClient.ts"
import { type PanelState, Request } from "../state/Panel.ts"
import * as Facts from "./Facts.ts"
import { Message, type Model } from "./Model.ts"
import { ask, count, fact, type H, header, mono, notices, pill, section } from "./Parts.ts"

type Ready = Extract<PanelState, { _tag: "Ready" }>

const plain = (h: H, model: Model, title: string, text: string): ReadonlyArray<Html> => [
  header(h, model, title),
  h.main([h.Class("body")], [...notices(h, model), h.p([h.Class("quiet-line")], [text])]),
  null
]

const wakeTargetText = (target: Session.Session | undefined): string =>
  target === undefined ? "Pull-only" : `${Facts.harnessName[target.harness]} session ${target.sessionId}`

const expiryText = (now: number, subscription: Subscription.Subscription): string =>
  DateTime.toEpochMillis(subscription.expiresAt) > now
    ? Facts.until(now, subscription.expiresAt)
    : Facts.ago(now, subscription.expiresAt)

const factsSection = (h: H, model: Model, subscription: Subscription.Subscription, state: Ready): Html => {
  const suspended = Facts.suspendedOn(subscription, Result.getOrElse(state.plugins, () => []))
  return h.section([h.Class("section subscription-facts")], [
    h.p([h.Class("state-sentence")], [Facts.stateSentence(model.now, subscription, suspended)]),
    fact(h, "Subscription", subscription.id, { mono: true }),
    fact(h, "Connector", subscription.plugin),
    fact(h, "Subject", subscription.subject, { mono: true }),
    fact(h, "Label", subscription.label === "" ? "None" : subscription.label),
    fact(h, "Intent", subscription.intent),
    fact(h, "Event types", subscription.eventTypes === undefined ? "All" : subscription.eventTypes.join(", ")),
    fact(h, "Wake target", wakeTargetText(subscription.wakeTarget)),
    fact(h, "Expires", expiryText(model.now, subscription))
  ])
}

const eventLine = (h: H, model: Model, event: Event.Event): ReadonlyArray<Html> => [
  h.span([h.Class("event-number mono")], [`#${event.number}`]),
  h.span([h.Class("event-body")], [
    h.span([h.Class("event-summary")], [event.summary]),
    h.span([h.Class("event-meta")], [mono(h, event.type, "event-type"), h.span([h.Class("sep")], [" · "]), Facts.ago(model.now, event.occurredAt)])
  ])
]

const eventsSection = (h: H, model: Model, detail: Detail, ackThrough: number | undefined): Html => {
  const pending = Facts.pendingEvents(detail)
  const acknowledged = Facts.acknowledgedEvents(detail)
  return section(h, "Events", [
    pending.length === 0 && acknowledged.length === 0 ? h.p([h.Class("quiet-line")], ["No events yet."]) : null,
    ...pending.map((event) =>
      h.keyed("button")(event.id, [
        h.Type("button"),
        h.Class(event.number <= (ackThrough ?? 0) ? "event event-pending event-in-ack" : "event event-pending"),
        h.AriaLabel(`Acknowledge through #${event.number}`),
        h.OnClick(Message.ChoseAckThrough({ number: event.number }))
      ], eventLine(h, model, event))
    ),
    acknowledged.length === 0 ? null : h.button([
      h.Type("button"),
      h.Class("disclosure"),
      h.AriaExpanded(model.acknowledgedOpen),
      h.OnClick(Message.ToggledAcknowledged())
    ], [
      h.span([h.Class("chevron")], [model.acknowledgedOpen ? "⌄" : "›"]),
      h.span([], ["Acknowledged events"]),
      h.span([h.Class("disclosure-count")], [String(acknowledged.length)])
    ]),
    ...(model.acknowledgedOpen
      ? acknowledged.map((event) => h.keyed("div")(event.id, [h.Class("event event-acknowledged")], eventLine(h, model, event)))
      : [])
  ], pending.length === 0 ? undefined : count(h, pending.length))
}

const wakeFacts = (now: number, wake: Wake.Wake): string =>
  [
    wake.attempts.count === 1 ? "1 attempt" : `${wake.attempts.count} attempts`,
    ...(wake.attempts.lastError === undefined ? [] : [`last error: ${wake.attempts.lastError}`]),
    ...(wake.attempts.nextAttemptAt === undefined ? [] : [`next attempt ${Facts.until(now, wake.attempts.nextAttemptAt)}`])
  ].join(", ")

const wakesSection = (h: H, model: Model, detail: Detail): Html => {
  const wakes = [...detail.wakes].sort((a, b) => DateTime.toEpochMillis(b.createdAt) - DateTime.toEpochMillis(a.createdAt))
  return section(h, "Wakes", [
    wakes.length === 0 ? h.p([h.Class("quiet-line")], ["No wakes yet."]) : null,
    ...wakes.map((wake) =>
      h.keyed("div")(wake.id, [h.Class("wake")], [
        h.p([h.Class("line-main")], [
          Facts.wakeReason(wake),
          pill(h, Facts.wakeState(wake)),
          h.span([h.Class("time")], [Facts.ago(model.now, wake.createdAt)])
        ]),
        h.p([h.Class("line-quiet")], [wakeFacts(model.now, wake)])
      ])
    )
  ])
}

const historySection = (h: H, model: Model, detail: Detail): Html => {
  const entries = Facts.history(detail)
  return section(h, "History", [
    entries.length === 0 ? h.p([h.Class("quiet-line")], ["Nothing has changed yet."]) : null,
    ...entries.map((entry) =>
      h.div([h.Class("history-entry")], [
        h.span([h.Class("history-title")], [entry.title]),
        h.span([h.Class("history-meta")], [`${entry.by}, ${Facts.ago(model.now, entry.at)}`])
      ])
    )
  ])
}

const sameTarget = (a: Session.Session | undefined, b: Session.Session | undefined): boolean =>
  a === undefined || b === undefined ? a === b : a.harness === b.harness && a.sessionId === b.sessionId

const retargetSection = (h: H, model: Model, subscription: Subscription.Subscription, state: Ready): Html => {
  const sessions = Facts.knownSessions(Result.getOrElse(state.subscriptions, () => []))
  const choices: ReadonlyArray<readonly [string, DaemonContract.TargetChoice]> = [
    ...sessions
      .filter((session) => !sameTarget(session, subscription.wakeTarget))
      .map((session) => [wakeTargetText(session), { _tag: "Session", session }] as const),
    ...(subscription.wakeTarget === undefined ? [] : [["Pull-only, no wake target", { _tag: "PullOnly" }] as const])
  ]
  return section(h, "Wake another session", [
    choices.length === 0
      ? h.p([h.Class("quiet-line")], ["No other session is known. A session becomes known once it subscribes."])
      : h.div([h.Class("retarget-choices")], choices.map(([label, target]) =>
        ask(h, model, label, Request.Retarget({ id: subscription.id, target }))
      ))
  ])
}

const actions = (h: H, model: Model, subscription: Subscription.Subscription, ackThrough: number | undefined): Html => {
  const { id } = subscription
  const tag = subscription.state._tag
  const open = tag === "Active" || tag === "Paused" || tag === "Expired"
  if (!open) return null
  return h.footer([h.Class("bar bar-bottom actions")], [
    ackThrough === undefined ? null : ask(h, model, `Acknowledge through #${ackThrough}`, Request.Ack({ id, through: ackThrough }), "primary"),
    tag === "Active" ? ask(h, model, "Pause", Request.Pause({ id })) : null,
    tag === "Paused" || tag === "Expired" ? ask(h, model, "Resume", Request.Resume({ id })) : null,
    h.button([
      h.Type("button"),
      h.Class(model.retargeting ? "button button-plain button-on" : "button button-plain"),
      h.AriaExpanded(model.retargeting),
      h.OnClick(Message.ToggledRetarget())
    ], ["Retarget"]),
    h.span([h.Class("bar-spacer")], []),
    ask(h, model, "Cancel", Request.Cancel({ id }), "danger")
  ])
}

/** One subscription in full: its facts, events, wakes and history, with the actions its state allows. */
export const subscription = (h: H, model: Model, id: string): ReadonlyArray<Html> => {
  const { state } = model
  if (state._tag === "Loading") return plain(h, model, "Subscription", "Asking the daemon.")
  if (state._tag === "DaemonNotRunning") return plain(h, model, "Subscription", `The daemon is not running: ${state.message}`)
  if (Result.isFailure(state.subscriptions)) {
    return plain(h, model, "Subscription", `Could not load subscriptions: ${state.subscriptions.failure}`)
  }
  const found = state.subscriptions.success.find((s) => s.id === id)
  if (found === undefined) return plain(h, model, "Subscription", `The daemon has no subscription ${id}.`)
  const ackThrough = Facts.ackThroughNumber(found, model.ackThrough)
  const detail = Result.map(state.details, (all) => all.find((d) => d.subscription.id === id))
  const sections: ReadonlyArray<Html> = Result.isFailure(detail)
    ? [h.p([h.Class("load-error")], [`Could not load its events and wakes: ${detail.failure}`])]
    : detail.success === undefined
    ? [h.p([h.Class("quiet-line")], ["Its events and wakes have not loaded yet."])]
    : [
      eventsSection(h, model, detail.success, ackThrough),
      wakesSection(h, model, detail.success),
      historySection(h, model, detail.success)
    ]
  const open = found.state._tag === "Active" || found.state._tag === "Paused" || found.state._tag === "Expired"
  return [
    header(h, model, found.label === "" ? found.subject : found.label),
    h.main([h.Class("body")], [
      ...notices(h, model),
      factsSection(h, model, found, state),
      open && model.retargeting ? retargetSection(h, model, found, state) : null,
      ...sections
    ]),
    actions(h, model, found, ackThrough)
  ]
}

