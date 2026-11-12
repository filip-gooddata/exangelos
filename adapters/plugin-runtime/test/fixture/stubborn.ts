import { BunStdio } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import { Plugin } from "@exangelos/plugin-sdk"
import { Template } from "@exangelos/plugin-template"

// Serves the template but ignores SIGTERM and never lets its event loop empty, so only SIGKILL stops it.
process.on("SIGTERM", () => {})
setInterval(() => {}, 1 << 30)

Plugin.serve(Template.plugin).pipe(Layer.provide(BunStdio.layer), Layer.launch, Effect.runFork)
