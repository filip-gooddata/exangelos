import { Result, Schema, Stream } from "effect"
import { Runtime, Subscription, type Update } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import type { Section } from "../daemon/DaemonClient.ts"
import { type PanelState, PanelState as States } from "../state/Panel.ts"

const SectionView = Schema.Struct({
  title: Schema.String,
  items: Schema.Array(Schema.String),
  error: Schema.NullOr(Schema.String)
})

export const Model = Schema.Struct({ status: Schema.String, sections: Schema.Array(SectionView) })
export type Model = typeof Model.Type

export const Message = defineMessageUnion({ Changed: { model: Model } })
export type Message = typeof Message.Type

const sectionView = <A>(title: string, section: Section<ReadonlyArray<A>>, line: (item: A) => string) =>
  Result.match(section, {
    onSuccess: (items) => ({ title, items: items.map(line), error: null }),
    onFailure: (message) => ({ title, items: [], error: message })
  })

export const toModel = (state: PanelState): Model =>
  States.$match(state, {
    Loading: () => ({ status: "Loading…", sections: [] }),
    DaemonNotRunning: ({ message }) => ({ status: `The daemon is not running: ${message}`, sections: [] }),
    Ready: ({ needsYou, plugins, subscriptions }) => ({
      status: "Connected",
      sections: [
        sectionView("Needs you", needsYou, (alert) => `${alert._tag}: ${alert.plugin}`),
        sectionView("Subscriptions", subscriptions, (s) => `${s.label}: ${s.intent}`),
        sectionView("Plugins", plugins, (p) => `${p.name} ${p.version} (${p.trust}, ${p.process})`)
      ]
    })
  })

const update = (_: Model, message: Message): Update.Return<Model, Message> =>
  Message.match<Update.Return<Model, Message>>(message, { Changed: ({ model }) => ({ model }) })

const view = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.div([], [
    h.p([], [model.status]),
    ...model.sections.map((section) =>
      h.div([], [
        h.h2([], [section.title]),
        section.error === null
          ? h.ul([], section.items.map((item) => h.li([], [item])))
          : h.p([], [`Could not load: ${section.error}`])
      ])
    )
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
