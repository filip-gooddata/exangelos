import * as NodeFileSystem from "@effect/platform-node-shared/NodeFileSystem"
import * as NodePath from "@effect/platform-node-shared/NodePath"
import { describe, expect, it } from "@effect/vitest"
import { ConfigProvider, Effect, FileSystem, Layer } from "effect"
import { ServiceManager as Port } from "@exangelos/application"
import { Paths } from "@exangelos/paths"
import { ServiceManager } from "@exangelos/service"
import * as FakeSpawner from "./FakeSpawner.ts"

const scenario = <A, E>(
  options: { executable: string; platform: "darwin" | "linux"; reply?: Parameters<typeof FakeSpawner.make>[0] },
  body: (root: string, fake: ReturnType<typeof FakeSpawner.make>) => Effect.Effect<A, E, Port.ServiceManager | FileSystem.FileSystem>
) =>
  Effect.scoped(Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped())
    const executable = `${root}/${options.executable}`
    yield* fs.makeDirectory(executable.slice(0, executable.lastIndexOf("/")), { recursive: true })
    yield* fs.writeFileString(executable, "")
    const fake = FakeSpawner.make(options.reply)
    const env = { HOME: `${root}/home`, EXANGELOS_HOME: `${root}/xa` }
    const layer = ServiceManager.layer({ executable, platform: options.platform, uid: 501 }).pipe(
      Layer.provide(Layer.mergeAll(fake.layer, Paths.layer)),
      Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord(env)))
    )
    return yield* body(root, fake).pipe(Effect.provide(layer))
  })).pipe(Effect.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)))

describe("ServiceManager", () => {
  it.effect("installs and starts its own LaunchAgent for a standalone binary on macOS", () =>
    scenario(
      { executable: "bin/exangelos", platform: "darwin", reply: (ran) => ran.args[0] === "print" ? { exitCode: 113 } : {} },
      (root, fake) =>
        Effect.gen(function*() {
          const fs = yield* FileSystem.FileSystem
          const manager = yield* Port.ServiceManager
          yield* manager.install
          yield* manager.start
          const plist = yield* fs.readFileString(`${root}/home/Library/LaunchAgents/exangelos.daemon.plist`)
          expect(plist).toContain(`<string>${root}/bin/exangelos</string>\n    <string>daemon</string>`)
          expect(plist).toContain(`<key>EXANGELOS_HOME</key>\n    <string>${root}/xa</string>`)
          expect(plist).toContain(`<string>${root}/xa/logs/daemon.log</string>`)
          expect(yield* fs.exists(`${root}/xa/logs`)).toBe(true)
          expect(fake.ran.map((ran) => [ran.command, ...ran.args].join(" "))).toEqual([
            "launchctl print gui/501/exangelos.daemon",
            `launchctl bootstrap gui/501 ${root}/home/Library/LaunchAgents/exangelos.daemon.plist`
          ])
        })
    ))

  it.effect("starts the formula's service for a Homebrew binary and installs nothing", () =>
    scenario(
      { executable: "Cellar/exangelos/1.0.0/bin/exangelos", platform: "darwin" },
      (root, fake) =>
        Effect.gen(function*() {
          const fs = yield* FileSystem.FileSystem
          const manager = yield* Port.ServiceManager
          yield* manager.install
          yield* manager.start
          expect(yield* fs.exists(`${root}/home/Library/LaunchAgents`)).toBe(false)
          expect(fake.ran.map((ran) => [ran.command, ...ran.args].join(" "))).toEqual([
            "brew services start exangelos"
          ])
        })
    ))

  it.effect("reports a failing status command with the systemd start method", () =>
    scenario(
      { executable: "bin/exangelos", platform: "linux", reply: () => ({ exitCode: 1, stderr: "Failed to connect to bus" }) },
      () =>
        Effect.gen(function*() {
          const manager = yield* Port.ServiceManager
          const error = yield* Effect.flip(manager.status)
          expect(error).toMatchObject({ _tag: "ServiceFailed", method: "systemd-user" })
        })
    ))
})
