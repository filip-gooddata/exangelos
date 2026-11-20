import { readFileSync } from "node:fs"
import { Effect, Layer, Option, Schema } from "effect"
import { Delivery, Event, Ids, Intake } from "../../../packages/domain/src/index.ts"
import { subscription } from "../../../packages/domain/test/fixtures.ts"
import { WakeTarget } from "../../../packages/application/src/ports/WakeTarget.ts"
import { layerSettingsStore } from "../../../packages/application/src/testing/SettingsStoreFake.ts"
import { layer } from "../../../adapters/wake-targets/src/WakeTargets.ts"
import { fakeBin, recordingSpawner } from "../../../adapters/wake-targets/test/fixtures.ts"

const input = Schema.decodeUnknownSync(Schema.Struct({ subject: Schema.String, once: Schema.Boolean, event: Schema.toCodecJson(Event.ReportedEvent) }))(
  JSON.parse(readFileSync(0, "utf8"))
)
const sub = subscription({ connector: Ids.ConnectorName.make("slack"), subject: input.subject, ...(input.once && { maxEvents: 1 }) })
const admitted = Intake.admit({ subscription: sub, reported: input.event, cursor: Option.none(), duplicate: false,
  id: Ids.EventId.make("evt_1"), now: input.event.occurredAt })
const content = Delivery.content(admitted.subscription, Option.getOrThrow(admitted.wake), [Option.getOrThrow(admitted.event)])
const captured = await Effect.runPromise(Effect.gen(function*() {
  const runner = yield* recordingSpawner({ exitCode: 0 })
  yield* Effect.gen(function*() {
    const target = yield* WakeTarget
    yield* target.deliver({ harness: "t3", sessionId: "fixture" }, content)
  }).pipe(Effect.provide(layer({ lookup: () => fakeBin }).pipe(Layer.provide([runner.layer, layerSettingsStore()]))))
  return yield* runner.spawned
}))
console.log(JSON.stringify(captured))
