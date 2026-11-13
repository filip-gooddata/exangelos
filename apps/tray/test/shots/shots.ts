import { Effect, Stream } from "effect"
import type { PanelState } from "../../src/state/Panel.ts"
import type { Screen } from "../../src/view/Model.ts"
import { mount } from "../../src/view/PanelView.ts"
import * as Fixtures from "../fixtures.ts"

interface Shot {
  readonly state: PanelState
  readonly screen: Screen
}

const shots: Record<string, Shot> = {
  "main-quiet": { state: Fixtures.quiet, screen: { _tag: "Main" } },
  "main-needs-you": { state: Fixtures.needsYou, screen: { _tag: "Main" } },
  subscription: { state: Fixtures.needsYou, screen: { _tag: "Subscription", id: "sub_7f3k" } },
  plugins: { state: Fixtures.needsYou, screen: { _tag: "Plugins" } },
  enable: { state: Fixtures.needsYou, screen: { _tag: "Plugin", name: Fixtures.inertPlugin.name } },
  "jira-rejected": { state: Fixtures.needsYou, screen: { _tag: "Plugin", name: "jira" } },
  settings: { state: Fixtures.quiet, screen: { _tag: "Settings" } },
  empty: { state: Fixtures.empty, screen: { _tag: "Main" } }
}

const params = new URLSearchParams(location.search)
const name = params.get("shot") ?? "main-quiet"
const shot = shots[name]
document.documentElement.dataset.theme = params.get("theme") === "dark" ? "dark" : "light"
document.documentElement.dataset.shot = name

if (shot === undefined) {
  document.body.textContent = `No shot named ${name}. Shots: ${Object.keys(shots).join(", ")}.`
} else {
  mount(
    document.getElementById("panel"),
    { changes: Stream.concat(Stream.make(shot.state), Stream.never), perform: () => Effect.void },
    { now: Fixtures.now, screen: shot.screen }
  )
}
