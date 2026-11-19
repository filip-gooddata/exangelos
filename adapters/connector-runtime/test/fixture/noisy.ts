import { BunStdio } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import { Connector } from "@exangelos/connector-sdk"
import { Template } from "@exangelos/connector-template"

process.stderr.write("noisy starting\n")
setTimeout(() => {
  process.stderr.write("noisy last words")
  process.exit(3)
}, 500)

Connector.serve(Template.connector).pipe(Layer.provide(BunStdio.layer), Layer.launch, Effect.runFork)
