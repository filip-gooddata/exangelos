import { Context, Effect, Layer, Option, Ref } from "effect"
import type { Session, Wake } from "@exangelos/domain"
import { DeliveryFailed, WakeTarget } from "../ports/WakeTarget.ts"

export interface Delivery {
  readonly session: Session.Session
  readonly content: Wake.WakeContent
  /** Set when the attempt failed. */
  readonly failure?: string
}

export class WakeTargetFake extends Context.Service<WakeTargetFake, {
  /** Every attempt, delivered or failed, in order. */
  readonly attempts: Effect.Effect<ReadonlyArray<Delivery>>
  /** Contents that reached their session, in order. */
  readonly delivered: Effect.Effect<ReadonlyArray<Wake.WakeContent>>
  /** Every later attempt fails with the reason until `recover`. */
  readonly failWith: (reason: string) => Effect.Effect<void>
  readonly recover: Effect.Effect<void>
}>()("@exangelos/application/testing/WakeTargetFake") {}

export const layerWakeTarget: Layer.Layer<WakeTarget | WakeTargetFake> = Layer.unwrap(Effect.gen(function*() {
  const attempts = yield* Ref.make<ReadonlyArray<Delivery>>([])
  const failure = yield* Ref.make(Option.none<string>())
  return Layer.merge(
    Layer.succeed(WakeTarget, {
      deliver: (session, content) =>
        Effect.flatMap(Ref.get(failure), Option.match({
          onNone: () => Ref.update(attempts, (all) => [...all, { session, content }]),
          onSome: (reason) =>
            Effect.andThen(
              Ref.update(attempts, (all) => [...all, { session, content, failure: reason }]),
              new DeliveryFailed({ reason })
            )
        }))
    }),
    Layer.succeed(WakeTargetFake, {
      attempts: Ref.get(attempts),
      delivered: Effect.map(Ref.get(attempts), (all) =>
        all.filter((attempt) => attempt.failure === undefined).map((attempt) => attempt.content)),
      failWith: (reason) => Ref.set(failure, Option.some(reason)),
      recover: Ref.set(failure, Option.none())
    })
  )
}))
