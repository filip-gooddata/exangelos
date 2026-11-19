import * as Fs from "node:fs/promises"
import * as Path from "node:path"
import { describe, expect, it } from "@effect/vitest"
import { ConfigProvider, Effect, Layer } from "effect"
import { Daemon } from "@exangelos/daemon"
import { Level } from "@exangelos/logging"
import { Paths } from "@exangelos/paths"
import { home, install, start, templateConnector } from "./support.ts"

const secret = "tok-7c1f9a3b-e2e"

const logs = (dir: string) =>
  Effect.promise(async () => {
    const names = await Fs.readdir(Path.join(dir, "logs"))
    return Promise.all(names.map(async (name) => ({ name, text: await Fs.readFile(Path.join(dir, "logs", name), "utf8") })))
  })

describe("daemon logs", () => {
  it.live("never write a configured secret, wherever it turns up", () =>
    Effect.gen(function*() {
      const dir = yield* home
      const { client, stop } = yield* start(dir)
      const source = yield* templateConnector(Path.join(dir, "sources"))
      yield* install(client, source, { token: secret, interval: "0" })
      const paths = Paths.layer.pipe(
        Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord({ EXANGELOS_HOME: dir }))),
        Layer.orDie
      )
      yield* Effect.logWarning(`connector said: token ${secret} refused`).pipe(
        Effect.annotateLogs({ connector: "template", detail: `sent ${secret}` }),
        Effect.provide(Daemon.logger.pipe(Layer.provide(paths)))
      )
      yield* stop
      const files = yield* logs(dir)
      expect(files.map((file) => file.name)).toContain("daemon.jsonl")
      for (const file of files) expect(file.text).not.toContain(secret)
      const daemon = files.find((file) => file.name === "daemon.jsonl")!.text
      expect(daemon).toContain("daemon started")
      expect(daemon).toContain("daemon stopped")
      expect(daemon).toContain("connector said: token [redacted] refused")
    }).pipe(Effect.scoped), 60_000)

  it.live("applies a logLevel the owner sets at once", () =>
    Effect.gen(function*() {
      const dir = yield* home
      const { client } = yield* start(dir)
      const settings = yield* client.GetSettings()
      yield* client.SetSettings({ settings: { ...settings, logLevel: "debug" } })
      expect(Level.current()).toBe("Debug")
      yield* client.SetSettings({ settings })
      expect(Level.current()).toBe("Info")
    }).pipe(Effect.scoped), 60_000)
})
