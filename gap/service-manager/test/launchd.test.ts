import { describe, expect, it } from "@effect/vitest"
import { Effect, FileSystem } from "effect"
import { layerLaunchd, renderPlist, ServiceStatus, UserService } from "@exangelos/service-manager"
import * as FakeSpawner from "./FakeSpawner.ts"
import { awkward, inTempDirectory, provide } from "./support.ts"

const printed = `gui/501/exangelos.daemon = {
\tactive count = 1
\tpath = /Users/me/Library/LaunchAgents/exangelos.daemon.plist
\tstate = running
\tpid = 4242
\tendpoints = {
\t\tstate = active
\t}
}
`

describe("layerLaunchd", () => {
  it.effect("installs, starts, reports, stops and uninstalls through launchctl", () =>
    inTempDirectory((directory) =>
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        let loaded = false
        const fake = FakeSpawner.make(({ args }) => {
          switch (args[0]) {
            case "print":
              return loaded ? { stdout: printed } : { exitCode: 113, stderr: "Bad request.\n" }
            case "bootstrap":
              loaded = true
              return {}
            case "bootout": {
              const wasLoaded = loaded
              loaded = false
              return wasLoaded ? {} : { exitCode: 3, stderr: "Boot-out failed: 3: No such process\n" }
            }
            default:
              return {}
          }
        })
        const plist = `${directory}/exangelos.daemon.plist`

        const statuses = yield* Effect.gen(function*() {
          const service = yield* UserService
          const before = yield* service.status("exangelos.daemon")
          yield* service.install(awkward)
          expect(yield* fs.readFileString(plist)).toBe(renderPlist(awkward))
          const installed = yield* service.status("exangelos.daemon")
          yield* service.start("exangelos.daemon")
          yield* service.start("exangelos.daemon")
          const running = yield* service.status("exangelos.daemon")
          yield* service.stop("exangelos.daemon")
          yield* service.uninstall("exangelos.daemon")
          expect(yield* fs.exists(plist)).toBe(false)
          return [before, installed, running]
        }).pipe(provide(layerLaunchd({ directory, uid: 501 }), fake))

        expect(statuses).toEqual([
          ServiceStatus.NotInstalled(),
          ServiceStatus.Stopped(),
          ServiceStatus.Running({ pid: 4242 })
        ])
        expect(fake.ran.map(FakeSpawner.line)).toEqual([
          "launchctl print gui/501/exangelos.daemon",
          "launchctl print gui/501/exangelos.daemon",
          "launchctl print gui/501/exangelos.daemon",
          `launchctl bootstrap gui/501 ${plist}`,
          "launchctl print gui/501/exangelos.daemon",
          "launchctl kickstart gui/501/exangelos.daemon",
          "launchctl print gui/501/exangelos.daemon",
          "launchctl bootout gui/501/exangelos.daemon",
          "launchctl bootout gui/501/exangelos.daemon"
        ])
      })
    ))

  it.effect("fails start with launchctl's stderr", () =>
    inTempDirectory((directory) =>
      Effect.gen(function*() {
        const fake = FakeSpawner.make(({ args }) =>
          args[0] === "print"
            ? { exitCode: 113 }
            : { exitCode: 5, stderr: "Bootstrap failed: 5: Input/output error\n" }
        )
        const error = yield* UserService.use((service) => service.start("exangelos.daemon")).pipe(
          provide(layerLaunchd({ directory, uid: 501 }), fake),
          Effect.flip
        )
        expect(error).toMatchObject({
          _tag: "ServiceFailed",
          operation: "start",
          reason: `launchctl bootstrap gui/501 ${directory}/exangelos.daemon.plist exited with 5: Bootstrap failed: 5: Input/output error`
        })
      })
    ))

  it.effect("refuses a label that would leave the directory", () =>
    inTempDirectory((directory) =>
      Effect.gen(function*() {
        const fake = FakeSpawner.make()
        const error = yield* UserService.use((service) => service.install({ ...awkward, label: "../escape" })).pipe(
          provide(layerLaunchd({ directory, uid: 501 }), fake),
          Effect.flip
        )
        expect(error).toMatchObject({ _tag: "ServiceFailed", operation: "install" })
        expect(fake.ran).toEqual([])
        expect(yield* (yield* FileSystem.FileSystem).readDirectory(directory)).toEqual([])
      })
    ))
})
