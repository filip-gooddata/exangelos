import { describe, expect, it } from "@effect/vitest"
import { ConfigProvider, Effect, Exit } from "effect"
import { Paths } from "../src/index.ts"

const resolve = (env: Record<string, string>) =>
  Paths.make.pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord(env))))

describe("Paths", () => {
  it.effect("follows XDG with home defaults", () =>
    Effect.gen(function*() {
      const paths = yield* resolve({ HOME: "/home/a", XDG_STATE_HOME: "/run/state" })
      expect(paths).toEqual({
        configDir: "/home/a/.config/exangelos",
        dataDir: "/home/a/.local/share/exangelos",
        stateDir: "/run/state/exangelos",
        settingsFile: "/home/a/.config/exangelos/settings.json",
        databaseFile: "/home/a/.local/share/exangelos/exangelos.db",
        pluginDir: "/home/a/.local/share/exangelos/plugins",
        socketPath: "/run/state/exangelos/daemon.sock",
        logDir: "/run/state/exangelos/logs"
      })
    }))

  it.effect("collapses every directory into EXANGELOS_HOME", () =>
    Effect.gen(function*() {
      const paths = yield* resolve({ HOME: "/home/a", XDG_DATA_HOME: "/x", EXANGELOS_HOME: "/tmp/xa" })
      expect([paths.configDir, paths.dataDir, paths.stateDir]).toEqual(["/tmp/xa", "/tmp/xa", "/tmp/xa"])
      expect(paths.socketPath).toBe("/tmp/xa/daemon.sock")
    }))

  it.effect("refuses a socket path the kernel cannot bind", () =>
    Effect.gen(function*() {
      const exit = yield* Effect.exit(resolve({ EXANGELOS_HOME: `/tmp/${"a".repeat(100)}` }))
      expect(Exit.isFailure(exit) && exit.cause.toString()).toContain("SocketPathTooLong")
    }))
})
