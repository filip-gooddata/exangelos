import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { SettingsOwnerOnly, setSettings, SettingsStore } from "@exangelos/application"
import { Session, Settings } from "@exangelos/domain"
import { withConnectors } from "../connectors/harness.ts"

const agent: Session.Actor = { _tag: "Session", session: { harness: "codex", sessionId: "c1" } }

describe("settings", () => {
  it.effect("refuses a session that changes them and writes nothing", () =>
    Effect.gen(function*() {
      const store = yield* SettingsStore.SettingsStore
      const before = yield* store.read
      const change = { ...Settings.initial, eventAlerts: true, limits: { ...Settings.initial.limits, backlogCount: 99 } }
      expect(yield* Effect.flip(setSettings(agent, change))).toEqual(new SettingsOwnerOnly())
      expect(yield* store.read).toEqual(before)
    }).pipe(withConnectors))
})
