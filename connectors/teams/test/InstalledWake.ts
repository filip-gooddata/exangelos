import assert from "node:assert/strict"
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, Layer, Option } from "effect"
import { Delivery, type Event, Ids, Intake } from "../../../packages/domain/src/index.ts"
import { subscription } from "../../../packages/domain/test/fixtures.ts"
import { WakeTarget } from "../../../packages/application/src/ports/WakeTarget.ts"
import { layerSettingsStore } from "../../../packages/application/src/testing/SettingsStoreFake.ts"
import { layer } from "../../../adapters/wake-targets/src/WakeTargets.ts"

export const deliver = (scratch: string, subject: string, event: Event.ReportedEvent) => Effect.gen(function*() {
  const bin = join(scratch, "t3")
  writeFileSync(bin, '#!/bin/sh\nprintf "%s\\n" "$@" > "$0.args"\n/bin/cat > "$0.stdin"\n', { mode: 0o700 })
  rmSync(bin + ".args", { force: true })
  rmSync(bin + ".stdin", { force: true })
  const sub = subscription({ connector: Ids.ConnectorName.make("teams"), subject, intent: "Observe fixture" })
  const admitted = Intake.admit({ subscription: sub, reported: event, cursor: Option.none(), duplicate: false,
    id: Ids.EventId.make("evt_1"), now: event.occurredAt })
  const content = Delivery.content(admitted.subscription, Option.getOrThrow(admitted.wake), [Option.getOrThrow(admitted.event)])
  const lookup = () => ({ home: scratch, path: scratch, platform: process.platform,
    isExecutable: (path: string) => path === bin && existsSync(path), listDirectory: () => [] })
  yield* Effect.gen(function*() {
    const target = yield* WakeTarget
    yield* target.deliver({ harness: "t3", sessionId: "fixture" }, content)
  }).pipe(Effect.provide(layer({ lookup }).pipe(Layer.provide([BunServices.layer, layerSettingsStore()]))))
  assert.equal(readFileSync(bin + ".args", "utf8"), "thread\nsend\n--\nfixture\n-\n")
  const text = readFileSync(bin + ".stdin", "utf8")
  assert.equal(text, `1 event on sub_7f3k (teams, ${subject})\n  #1 ${event.type}   ${event.summary}\nRead  exangelos events sub_7f3k\nAck   exangelos ack sub_7f3k --through 1`)
  return text
})
