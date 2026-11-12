import { Context, Effect, Layer, Option, Ref } from "effect"
import { AlertFailed, AlertSink, type Alert } from "../ports/AlertSink.ts"

export class AlertSinkFake extends Context.Service<AlertSinkFake, {
  /** Alerts shown, in order; failed ones are not. */
  readonly shown: Effect.Effect<ReadonlyArray<Alert>>
  /** Every later alert fails with the reason until `recover`. */
  readonly failWith: (reason: string) => Effect.Effect<void>
  readonly recover: Effect.Effect<void>
}>()("@exangelos/application/testing/AlertSinkFake") {}

export const layerAlertSink: Layer.Layer<AlertSink | AlertSinkFake> = Layer.unwrap(Effect.gen(function*() {
  const shown = yield* Ref.make<ReadonlyArray<Alert>>([])
  const failure = yield* Ref.make(Option.none<string>())
  return Layer.merge(
    Layer.succeed(AlertSink, {
      show: (alert) =>
        Effect.flatMap(Ref.get(failure), Option.match({
          onNone: () => Ref.update(shown, (all) => [...all, alert]),
          onSome: (reason) => Effect.fail(new AlertFailed({ reason }))
        }))
    }),
    Layer.succeed(AlertSinkFake, {
      shown: Ref.get(shown),
      failWith: (reason) => Ref.set(failure, Option.some(reason)),
      recover: Ref.set(failure, Option.none())
    })
  )
}))
