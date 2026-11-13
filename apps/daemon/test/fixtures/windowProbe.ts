import { BunRuntime, BunStdio } from "@effect/platform-bun"
import { DateTime, Duration, Effect, Layer, Schema, Stream } from "effect"
import { Catalogue, Connector } from "@exangelos/connector-sdk"
import { Limits } from "@exangelos/domain"

const opened = Catalogue.event("opened", {
  description: "The watch opened",
  payload: Schema.Struct({ wakeWindow: Schema.Number })
})

const connector = Connector.make({
  events: [opened],
  parameters: Catalogue.parameters({ main: "label", schema: Schema.Struct({ label: Schema.String }) }),
  configuration: [],
  handlers: Effect.succeed({
    configure: () => Effect.void,
    describe: () => Effect.succeed({ subject: "window", label: "Wake window" }),
    watch: ({ wakeWindow }) => {
      const millis = Duration.toMillis(wakeWindow)
      if (Duration.equals(wakeWindow, Limits.defaults.wakeWindow)) {
        return Stream.concat(
          Stream.fromEffect(DateTime.now.pipe(Effect.map((occurredAt) =>
            opened.item({ occurredAt, summary: "Opened", payload: { wakeWindow: millis }, dedupeKey: "opened" })
          ))),
          Stream.never
        )
      }
      return Stream.make(Connector.end(`wake window ${millis} ms`))
    }
  })
})

Connector.serve(connector).pipe(Layer.provide(BunStdio.layer), Layer.launch, BunRuntime.runMain)
