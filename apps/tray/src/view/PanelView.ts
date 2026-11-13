import { type Effect, Stream } from "effect"
import { Runtime, Subscription } from "foldkit"
import type { Html } from "foldkit/html"
import { PanelState, type Refusal, type Request } from "../state/Panel.ts"
import { main } from "./Main.ts"
import { initial, makeUpdate, Message, Model, type Screen } from "./Model.ts"
import type { H } from "./Parts.ts"
import { plugin, plugins } from "./Plugins.ts"
import { settings } from "./Settings.ts"
import { subscription } from "./Subscription.ts"

/** What the view needs from the Panel service. */
export interface Source {
  readonly changes: Stream.Stream<PanelState>
  readonly perform: (request: Request) => Effect.Effect<void, Refusal>
}

export interface Options {
  /** A fixed time; the clock then never moves. */
  readonly now?: number
  readonly screen?: Screen
}

const screen = (h: H, model: Model): ReadonlyArray<Html> => {
  switch (model.screen._tag) {
    case "Main":
      return main(h, model)
    case "Subscription":
      return subscription(h, model, model.screen.id)
    case "Plugins":
      return plugins(h, model)
    case "Plugin":
      return plugin(h, model, model.screen.name)
    case "Settings":
      return settings(h, model)
  }
}

export const view = (model: Model, h: H): Html => h.div([h.Class("panel")], [...screen(h, model)])

const tick = "30 seconds"

/** Mounts the panel in `container`: it redraws on every state from `source` and sends your actions to `source.perform`. */
export const mount = (container: HTMLElement | null, source: Source, options: Options = {}): void =>
  Runtime.run(Runtime.makeElement({
    Model,
    init: () => ({ model: initial(PanelState.Loading(), options.now ?? Date.now(), options.screen) }),
    update: makeUpdate(source.perform),
    view,
    container,
    subscriptions: Subscription.make<Model, Message>()(() => ({
      panel: Subscription.persistentEntry(Stream.map(source.changes, (state) => Message.Changed({ state }))),
      clock: Subscription.persistentEntry(
        options.now === undefined ? Stream.map(Stream.tick(tick), () => Message.Ticked({ now: Date.now() })) : Stream.never
      )
    }))
  }))
