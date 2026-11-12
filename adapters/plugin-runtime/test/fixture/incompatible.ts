import { BunRuntime, BunStdio } from "@effect/platform-bun"
import { Effect, Layer, Stream } from "effect"
import { PluginProtocol } from "@exangelos/contracts"
import { Plugin } from "@exangelos/plugin-sdk"
import { Template } from "@exangelos/plugin-template"

const handlers = PluginProtocol.PluginProtocol.toLayer({
  Handshake: () =>
    Effect.succeed({ protocolVersion: PluginProtocol.version + 1, catalogue: Template.plugin.catalogue }),
  Configure: () => Effect.die("unused"),
  Describe: () => Effect.die("unused"),
  Watch: () => Stream.die("unused")
})

Plugin.serve({ layer: handlers }).pipe(Layer.provide(BunStdio.layer), Layer.launch, BunRuntime.runMain)
