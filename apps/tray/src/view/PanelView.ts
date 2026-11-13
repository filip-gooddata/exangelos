import type { Alert } from "@exangelos/domain"
import { Option, Result, Schema, Stream } from "effect"
import { Runtime, Subscription, type Update } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { bySession, type PanelState, PanelState as States, stateFact } from "../state/Panel.ts"

const NeedsYouItem = Schema.Struct({ text: Schema.String, action: Schema.String })
const Row = Schema.Struct({ label: Schema.String, intent: Schema.String, detail: Schema.String })
const Group = Schema.Struct({ title: Schema.String, rows: Schema.Array(Row) })

export const Model = Schema.Struct({
  status: Schema.String,
  needsYou: Schema.Struct({ items: Schema.Array(NeedsYouItem), error: Schema.NullOr(Schema.String) }),
  sessions: Schema.Struct({ groups: Schema.Array(Group), error: Schema.NullOr(Schema.String) }),
  plugins: Schema.Struct({ items: Schema.Array(Schema.String), error: Schema.NullOr(Schema.String) })
})
export type Model = typeof Model.Type

export const Message = defineMessageUnion({ Changed: { model: Model } })
export type Message = typeof Message.Type

const harnessNames = { t3: "T3 Code", "claude-code": "Claude Code", codex: "Codex" } as const

const needsYouItem = (alert: Alert.Alert): typeof NeedsYouItem.Type => {
  switch (alert._tag) {
    case "WaitsForEnable":
      return { text: `${alert.plugin} waits to be enabled`, action: "Enable" }
    case "DigestMismatch":
      return { text: `${alert.plugin} does not match its official checksum`, action: "Review" }
    case "Failing":
      return { text: `${alert.plugin} keeps failing: ${alert.reason}`, action: "Restart" }
    case "CredentialsRejected":
      return { text: `${alert.plugin} credentials were rejected: ${alert.reason}`, action: "Configure" }
    default:
      return { text: `${alert._tag}: ${alert.plugin}`, action: "Open" }
  }
}

const empty = { items: [], error: null }

export const toModel = (state: PanelState): Model =>
  States.$match(state, {
    Loading: () => ({ status: "Loading…", needsYou: empty, sessions: { groups: [], error: null }, plugins: empty }),
    DaemonNotRunning: ({ message }) => ({
      status: `The daemon is not running: ${message}`,
      needsYou: empty,
      sessions: { groups: [], error: null },
      plugins: empty
    }),
    Ready: ({ needsYou, plugins, subscriptions }) => ({
      status: "Daemon running",
      needsYou: Result.match(needsYou, {
        onSuccess: (alerts) => ({ items: alerts.map(needsYouItem), error: null }),
        onFailure: (error) => ({ items: [], error })
      }),
      sessions: Result.match(subscriptions, {
        onSuccess: (loaded) => ({
          groups: bySession(loaded).map((group) => ({
            title: Option.match(group.wakeTarget, {
              onNone: () => "Pull-only",
              onSome: ({ harness, sessionId }) => `${harnessNames[harness]} ${sessionId}`
            }),
            rows: group.subscriptions.map((s) => ({ label: s.label, intent: s.intent, detail: `${s.subject} · ${stateFact(s)}` }))
          })),
          error: null
        }),
        onFailure: (error) => ({ groups: [], error })
      }),
      plugins: Result.match(plugins, {
        onSuccess: (loaded) => ({ items: loaded.map((p) => `${p.name} ${p.version} (${p.trust}, ${p.process})`), error: null }),
        onFailure: (error) => ({ items: [], error })
      })
    })
  })

const update = (_: Model, message: Message): Update.Return<Model, Message> =>
  Message.match<Update.Return<Model, Message>>(message, { Changed: ({ model }) => ({ model }) })

const ember = { background: "#E2622B", color: "white", border: "none", "border-radius": "4px" }

const failed = (h: HtmlBuilder<Message>, error: string) => h.p([], [`Could not load: ${error}`])

const view = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.div([], [
    h.p([], [model.status]),
    ...(model.needsYou.error !== null
      ? [h.section([], [h.h2([], ["Needs you"]), failed(h, model.needsYou.error)])]
      : model.needsYou.items.length === 0
      ? []
      : [h.section([], [
        h.h2([], [`Needs you ${model.needsYou.items.length}`]),
        h.ul(
          [],
          model.needsYou.items.map((item) =>
            h.li([], [h.span([], [item.text]), " ", h.button([h.Style(ember)], [item.action])])
          )
        )
      ])]),
    h.section(
      [],
      model.sessions.error !== null
        ? [h.h2([], ["Subscriptions"]), failed(h, model.sessions.error)]
        : model.sessions.groups.map((group) =>
          h.div([], [
            h.h2([], [group.title]),
            h.ul(
              [],
              group.rows.map((row) =>
                h.li([], [h.div([], [row.label]), h.div([], [row.intent]), h.div([], [h.small([], [row.detail])])])
              )
            )
          ])
        )
    ),
    h.section([], [
      h.h2([], ["Plugins"]),
      model.plugins.error !== null
        ? failed(h, model.plugins.error)
        : h.ul([], model.plugins.items.map((item) => h.li([], [item])))
    ])
  ])

/** Mounts the placeholder panel in `container` and redraws it on every state in `states`. */
export const mount = (container: HTMLElement | null, states: Stream.Stream<PanelState>): void =>
  Runtime.run(Runtime.makeElement({
    Model,
    init: () => ({ model: toModel(States.Loading()) }),
    update,
    view,
    container,
    subscriptions: Subscription.make<Model, Message>()(() => ({
      panel: Subscription.persistentEntry(Stream.map(states, (state) => Message.Changed({ model: toModel(state) })))
    }))
  }))
