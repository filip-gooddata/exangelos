import { BunStdio } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import { Connector } from "@exangelos/connector-sdk"
import { Template } from "@exangelos/connector-template"

process.on("SIGTERM", () => {})
setInterval(() => {}, 1 << 30)

Connector.serve(Template.connector).pipe(Layer.provide(BunStdio.layer), Layer.launch, Effect.runFork)
