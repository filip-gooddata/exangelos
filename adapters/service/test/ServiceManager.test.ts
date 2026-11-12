import * as NodeFileSystem from "@effect/platform-node-shared/NodeFileSystem"
import * as NodePath from "@effect/platform-node-shared/NodePath"
import { describe, expect, it } from "@effect/vitest"
import { ConfigProvider, Effect, FileSystem, Layer } from "effect"
import { ServiceManager as Port } from "@exangelos/application"
import { Paths } from "@exangelos/paths"
import { ServiceManager } from "@exangelos/service"
import * as FakeSpawner from "./FakeSpawner.ts"

const scenario = <A, E>(
  options: {
    executable: string
    platform: "darwin" | "linux"
    reply?: Parameters<typeof FakeSpawner.make>[0]
    env?: (root: string) => Record<string, string>
  },
  body: (root: string, fake: ReturnType<typeof FakeSpawner.make>) => Effect.Effect<A, E, Port.ServiceManager | FileSystem.FileSystem>
) =>
  Effect.scoped(Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped())
    const executable = `${root}/${options.executable}`
    yield* fs.makeDirectory(executable.slice(0, executable.lastIndexOf("/")), { recursive: true })
    yield* fs.writeFileString(executable, "")
    const fake = FakeSpawner.make(options.reply)
    const env = { HOME: `${root}/home`, EXANGELOS_HOME: `${root}/xa`, ...options.env?.(root) }
    const service = { executable, platform: options.platform, uid: 501 }
    const layer = ServiceManager.layer.pipe(
      Layer.provide(ServiceManager.layerUserService(service)),
      Layer.provideMerge(ServiceManager.layerInstallation(service)),
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

  it.effect("starts the formula's service through its own brew and refuses overrides it cannot pass on", () =>
    scenario(
      { executable: "Cellar/exangelos/1.0.0/bin/exangelos", platform: "darwin" },
      (root, fake) =>
        Effect.gen(function*() {
          const manager = yield* Port.ServiceManager
          const refused = yield* Effect.flip(manager.install)
          expect(refused).toMatchObject({ _tag: "ServiceFailed", method: "homebrew" })
          expect(refused.reason).toContain("EXANGELOS_HOME")
          yield* manager.start
          expect(fake.ran.map((ran) => [ran.command, ...ran.args].join(" "))).toEqual([
            `${root}/bin/brew services start exangelos`
          ])
        })
    ))

  it.effect("writes the systemd user unit under XDG_CONFIG_HOME and passes the variable on", () =>
    scenario(
      { executable: "bin/exangelos", platform: "linux", env: (root) => ({ XDG_CONFIG_HOME: `${root}/cfg` }) },
      (root, fake) =>
        Effect.gen(function*() {
          const fs = yield* FileSystem.FileSystem
          yield* (yield* Port.ServiceManager).install
          const unit = yield* fs.readFileString(`${root}/cfg/systemd/user/exangelos.daemon.service`)
          expect(unit).toContain(`ExecStart="${root}/bin/exangelos" "daemon"`)
          expect(unit).toContain(`Environment="XDG_CONFIG_HOME=${root}/cfg"`)
          expect(fake.ran.map((ran) => [ran.command, ...ran.args].join(" "))).toEqual([
            "systemctl --user daemon-reload",
            "systemctl --user enable exangelos.daemon.service"
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
