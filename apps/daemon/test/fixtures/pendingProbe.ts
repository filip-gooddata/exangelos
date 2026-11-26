import * as Fs from "node:fs"
import { BunRuntime, BunStdio } from "@effect/platform-bun"
import { DateTime, Effect, Layer, Schema, Stream } from "effect"
import { Catalogue, Connector } from "@exangelos/connector-sdk"

const appeared = Catalogue.event("appeared", {
  description: "The subject appeared",
  payload: Schema.Struct({})
})

/** Waits for a subject that never appears, and logs each Watch call's cursor and creation time to `log`. */
const connector = Connector.make({
  events: [appeared],
  parameters: Catalogue.parameters({ main: "log", schema: Schema.Struct({ log: Schema.String }) }),
  configuration: [],
  handlers: Effect.succeed({
    configure: () => Effect.void,
    describe: () => Effect.succeed({ subject: "missing", label: "A subject not there yet" }),
    watch: ({ parameters, cursor, createdAt }) => {
      Fs.appendFileSync(
        parameters.log,
        `${JSON.stringify({ cursor: cursor ?? null, createdAt: createdAt === undefined ? null : DateTime.formatIso(createdAt) })}\n`
      )
      if (cursor !== undefined) return Stream.never
      const waiting = Connector.pending("Not in the local cache yet", "c1")
      return Stream.concat(Stream.make(waiting, waiting), Stream.never)
    }
  })
})

Connector.serve(connector).pipe(Layer.provide(BunStdio.layer), Layer.launch, BunRuntime.runMain)
