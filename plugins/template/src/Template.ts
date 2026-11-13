import { Clock, DateTime, Duration, Effect, Option, Ref, Schema, Stream } from "effect"
import { Catalogue, Plugin } from "@exangelos/plugin-sdk"

export const tick = Catalogue.event("tick", {
  description: "One tick of the countdown",
  payload: Schema.Struct({ index: Schema.Int })
})

const parameters = Catalogue.parameters({
  main: "ticks",
  schema: Schema.Struct({ ticks: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1000 })) })
})

const Interval = Schema.FiniteFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))

interface Configuration {
  readonly token: string
  readonly interval: Duration.Duration
}

const resumeAfter = (cursor: string | undefined) => {
  const index = Number(cursor)
  return Number.isInteger(index) && index > 0 ? index : 0
}

export const plugin = Plugin.make({
  events: [tick],
  parameters,
  configuration: [
    Catalogue.secret("token", { label: "Token" }),
    Catalogue.text("interval", { label: "Milliseconds between ticks", required: false })
  ],
  handlers: Effect.gen(function*() {
    const configuration = yield* Ref.make(Option.none<Configuration>())
    return {
      configure: (values) =>
        Schema.decodeEffect(Interval)(values.interval || "0").pipe(
          Effect.mapError(() =>
            new Plugin.ConfigurationRejected({ reason: "Interval must be a whole number of milliseconds" })
          ),
          Effect.flatMap((interval) =>
            Ref.set(configuration, Option.some({ token: values.token ?? "", interval: Duration.millis(interval) }))
          )
        ),
      describe: ({ ticks }) => Effect.succeed({ subject: `ticks:${ticks}`, label: `${ticks} ticks` }),
      watch: ({ parameters: { ticks }, cursor, wakeWindow }) =>
        Stream.unwrap(
          Effect.gen(function*() {
            const { interval } = yield* Ref.get(configuration).pipe(
              Effect.flatMap(Effect.fromOption),
              Effect.mapError(() => new Plugin.CredentialsRejected({ reason: "The template plugin is not configured" }))
            )
            const remaining = Stream.range(resumeAfter(cursor) + 1, ticks).pipe(
              Stream.mapEffect((index) =>
                Effect.gen(function*() {
                  if (index > 1 && Duration.isGreaterThan(interval, Duration.zero)) yield* Effect.sleep(interval)
                  const occurredAt = DateTime.makeUnsafe(yield* Clock.currentTimeMillis)
                  return tick.item({
                    occurredAt,
                    summary: `Tick ${index} of ${ticks}`,
                    payload: { index },
                    dedupeKey: `tick-${index}`,
                    cursor: String(index)
                  })
                })
              )
            )
            return Stream.concat(remaining, Stream.make(Plugin.end(`Emitted ${ticks} ticks; wake window ${Duration.toMillis(wakeWindow)} ms`)))
          })
        )
    }
  })
})
