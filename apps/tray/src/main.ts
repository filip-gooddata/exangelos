import { BrowserRuntime } from "@effect/platform-browser"
import { TauriIpcSocket } from "@exangelos/rpc-tauri-ipc"
import { Channel, invoke, type InvokeArgs } from "@tauri-apps/api/core"
import { Effect, Layer, Option, Stream } from "effect"
import { DaemonClient, Host, Panel, PanelView } from "./index.ts"

const live = Panel.layer("5 seconds").pipe(
  Layer.provide(DaemonClient.layer),
  Layer.provide(TauriIpcSocket.layer({
    invoke: (command, args, options) => invoke(command, args as InvokeArgs, options?.headers === undefined ? undefined : { headers: options.headers }),
    makeChannel: (onMessage) => new Channel(onMessage)
  })),
  Layer.provideMerge(Host.layer(invoke))
)

const smoke = Effect.gen(function*() {
  const panel = yield* Panel.Panel
  const host = yield* Host.Host
  const loaded = yield* panel.changes.pipe(
    Stream.filter((state) => state._tag !== "Loading"),
    Stream.runHead,
    Effect.timeoutOption("10 seconds"),
    Effect.map(Option.flatten)
  )
  yield* host.smokeReport(Panel.smokeReport(Option.getOrElse(loaded, () => Panel.PanelState.Loading())))
})

const main = Effect.gen(function*() {
  const host = yield* Host.Host
  if ((yield* host.info).smoke) return yield* smoke
  PanelView.mount(document.getElementById("panel"), yield* Panel.Panel)
  return yield* Effect.never
}).pipe(Effect.provide(live))

BrowserRuntime.runMain(main)
