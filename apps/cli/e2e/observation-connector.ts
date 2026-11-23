import { appendFileSync, existsSync } from "node:fs"
import { BunRuntime, BunStdio } from "@effect/platform-bun"
import { Effect, Layer, Schema, Stream } from "effect"
import { Catalogue, Connector } from "../../../packages/connector-sdk/src/index.ts"

const connector = Connector.make({
  events: [Catalogue.event("changed", { description: "Fixture change", payload: Schema.Struct({}) })],
  parameters: Catalogue.parameters({ main: "marker", schema: Schema.Struct({ marker: Schema.String }) }),
  configuration: [],
  handlers: Effect.succeed({
    configure: () => Effect.void,
    describe: () => Effect.succeed({ subject: "fixture", label: "Fixture" }),
    watch: ({ parameters: { marker }, cursor }) => Stream.suspend(() => {
      appendFileSync(marker + ".attempts", (cursor ?? "initial") + "\n")
      if (existsSync(marker)) return Stream.fail(new Connector.SourceFailed({
        category: "unreadable", reason: "private-fixture-error-content"
      }))
      return Stream.concat(Stream.make(Connector.cursor("baseline")), Stream.never)
    })
  })
})
Connector.serve(connector).pipe(Layer.provide(BunStdio.layer), Layer.launch, BunRuntime.runMain)
