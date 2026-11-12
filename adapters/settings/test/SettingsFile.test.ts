import { NodeFileSystem, NodePath } from "@effect/platform-node-shared"
import { describe, expect, it } from "@effect/vitest"
import { Duration, Effect, FileSystem, Layer } from "effect"
import { Settings } from "@exangelos/domain"
import { SettingsFile } from "../src/index.ts"

const Platform = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)

const settingsPath = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const directory = yield* fs.makeTempDirectoryScoped()
  return `${directory}/config/settings.json`
})

describe("SettingsFile", () => {
  it.effect("gives the defaults when the file is missing", () =>
    Effect.gen(function*() {
      const path = yield* settingsPath
      expect(yield* SettingsFile.read(path)).toEqual(Settings.initial)
    }).pipe(Effect.provide(Platform)))

  it.effect("reads back what it wrote", () =>
    Effect.gen(function*() {
      const path = yield* settingsPath
      const changed: Settings.Settings = {
        eventAlerts: true,
        limits: { ...Settings.initial.limits, backlogCount: 5, wakeWindow: Duration.seconds(30) },
        officialPluginFolder: "/srv/plugins"
      }
      yield* SettingsFile.write(path, changed)
      expect(yield* SettingsFile.read(path)).toEqual(changed)
    }).pipe(Effect.provide(Platform)))

  it.effect("fills keys a hand-edited file leaves out", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* settingsPath
      yield* SettingsFile.write(path, Settings.initial)
      yield* fs.writeFileString(path, JSON.stringify({ limits: { backlogCount: 3 } }))
      const settings = yield* SettingsFile.read(path)
      expect(settings.limits.backlogCount).toBe(3)
      expect(settings.limits.retention).toEqual(Settings.initial.limits.retention)
      expect(settings.eventAlerts).toBe(Settings.initial.eventAlerts)
    }).pipe(Effect.provide(Platform)))

  it.effect("refuses a file that fails to decode", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* settingsPath
      yield* SettingsFile.write(path, Settings.initial)
      yield* fs.writeFileString(path, JSON.stringify({ eventAlerts: "yes" }))
      const error = yield* Effect.flip(SettingsFile.read(path))
      expect(error._tag).toBe("SettingsFileUnreadable")
      expect(error.path).toBe(path)
    }).pipe(Effect.provide(Platform)))
})
