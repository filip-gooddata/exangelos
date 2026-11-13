import { NodeFileSystem, NodePath } from "@effect/platform-node-shared"
import { describe, expect, it } from "@effect/vitest"
import { ConfigProvider, Duration, Effect, FileSystem, Layer } from "effect"
import { SettingsStore } from "@exangelos/application"
import { Settings } from "@exangelos/domain"
import { Paths } from "@exangelos/paths"
import { SettingsFile } from "../src/index.ts"

const Platform = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)

const withStore = <A, E>(test: (path: string, store: SettingsStore.SettingsStore["Service"]) => Effect.Effect<A, E, FileSystem.FileSystem>) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const home = yield* fs.makeTempDirectoryScoped()
    const store = yield* SettingsStore.SettingsStore.pipe(
      Effect.provide(SettingsFile.layer.pipe(
        Layer.provide(Paths.layer),
        Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord({ EXANGELOS_HOME: home })))
      ))
    )
    return yield* test(`${home}/settings.json`, store)
  }).pipe(Effect.provide(Platform))

describe("SettingsFile", () => {
  it.effect("gives the defaults when the file is missing", () =>
    withStore((_, store) =>
      Effect.gen(function*() {
        expect(yield* store.read).toEqual(Settings.initial)
      })
    ))

  it.effect("reads back what it wrote", () =>
    withStore((_, store) =>
      Effect.gen(function*() {
        const changed: Settings.Settings = {
          eventAlerts: true,
          limits: { ...Settings.initial.limits, backlogCount: 5, wakeWindow: Duration.seconds(30) },
          officialConnectorFolder: "/srv/connectors"
        }
        yield* store.write(changed)
        expect(yield* store.read).toEqual(changed)
      })
    ))

  it.effect("fills keys a hand-edited file leaves out", () =>
    withStore((path, store) =>
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        yield* store.write(Settings.initial)
        yield* fs.writeFileString(path, JSON.stringify({ limits: { backlogCount: 3 } }))
        const settings = yield* store.read
        expect(settings.limits.backlogCount).toBe(3)
        expect(settings.limits.retention).toEqual(Settings.initial.limits.retention)
        expect(settings.eventAlerts).toBe(Settings.initial.eventAlerts)
      })
    ))

  it.effect("refuses a file that fails to decode", () =>
    withStore((path, store) =>
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        yield* store.write(Settings.initial)
        yield* fs.writeFileString(path, JSON.stringify({ eventAlerts: "yes" }))
        const error = yield* Effect.flip(store.read)
        expect(error).toBeInstanceOf(SettingsStore.SettingsUnreadable)
        expect(error.path).toBe(path)
        yield* fs.writeFileString(path, JSON.stringify({ limits: null }))
        expect(yield* Effect.flip(store.read)).toBeInstanceOf(SettingsStore.SettingsUnreadable)
      })
    ))
})
