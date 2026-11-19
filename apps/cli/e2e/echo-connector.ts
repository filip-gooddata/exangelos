import { BunRuntime, BunStdio } from "@effect/platform-bun"
import { DateTime, Effect, Layer, Schema, Stream } from "effect"
import { Catalogue, Connector } from "../../../packages/connector-sdk/src/index.ts"

const echoed = Catalogue.event("echoed", {
  description: "The note it was asked to echo",
  payload: Schema.Struct({ note: Schema.String })
})

const parameters = Catalogue.parameters({ main: "note", schema: Schema.Struct({ note: Schema.String }) })

console.error("startup echo", process.env.XNG_E2E_TOKEN ?? "")

const connector = Connector.make({
  events: [echoed],
  parameters,
  configuration: [Catalogue.secret("token", { label: "Token" })],
  handlers: Effect.succeed({
    configure: (values) => Effect.sync(() => console.error("configure echo", values.token ?? "")),
    describe: () => Effect.succeed({ subject: "note", label: "a note" }),
    watch: ({ parameters: { note } }) =>
      Stream.make(
        echoed.item({
          occurredAt: DateTime.makeUnsafe(Date.now()),
          summary: "Echoed the note",
          payload: { note },
          dedupeKey: "echo",
          cursor: "1"
        }),
        Connector.end("Echoed once")
      )
  })
})

Connector.serve(connector).pipe(Layer.provide(BunStdio.layer), Layer.launch, BunRuntime.runMain)
