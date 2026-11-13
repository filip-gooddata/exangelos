import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { Harnesses, setSettings, SettingsStore } from "@exangelos/application"
import { Session, Settings } from "@exangelos/domain"
import { withConnectors, you } from "../connectors/harness.ts"

const agent: Session.Actor = { _tag: "Session", session: { harness: "codex", sessionId: "c1" } }
const relay = Session.HarnessName.make("relay")
const definition = { command: ["/opt/relay", "{session}"] }

describe("harnesses you define", () => {
  it.effect("refuses a session that defines or removes one", () =>
    Effect.gen(function*() {
      expect(yield* Effect.flip(Harnesses.setHarness(agent, relay, definition))).toEqual(new Harnesses.HumanRequired({ harness: "relay" }))
      yield* Harnesses.setHarness(you, relay, definition)
      expect(yield* Effect.flip(Harnesses.removeHarness(agent, relay))).toEqual(new Harnesses.HumanRequired({ harness: "relay" }))
      expect((yield* (yield* SettingsStore.SettingsStore).read).harnesses).toEqual({ relay: definition })
    }).pipe(withConnectors))

  it.effect("keeps them when the other settings change", () =>
    Effect.gen(function*() {
      yield* Harnesses.setHarness(you, relay, definition)
      const written = yield* setSettings(you, { ...Settings.initial, eventAlerts: true })
      expect(written.harnesses).toEqual({ relay: definition })
      expect(yield* (yield* SettingsStore.SettingsStore).read).toEqual({ ...Settings.initial, eventAlerts: true, harnesses: { relay: definition } })
    }).pipe(withConnectors))
})
