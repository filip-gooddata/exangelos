import { describe, expect, it } from "@effect/vitest"
import { Effect, FileSystem } from "effect"
import { layerSystemd, renderSystemdUnit, ServiceStatus, UserService } from "@exangelos/service-manager"
import * as FakeSpawner from "./FakeSpawner.ts"
import { awkward, inTempDirectory, provide } from "./support.ts"

describe("layerSystemd", () => {
  it.effect("installs, starts, reports, stops and uninstalls through systemctl --user", () =>
    inTempDirectory((directory) =>
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        let active = false
        const fake = FakeSpawner.make(({ args }) => {
          switch (args[1]) {
            case "start":
              active = true
              return {}
            case "stop":
              active = false
              return {}
            case "is-active":
              return active ? { stdout: "active\n" } : { exitCode: 3, stdout: "inactive\n" }
            case "show":
              return { stdout: "4242\n" }
            default:
              return {}
          }
        })
        const unit = `${directory}/exangelos.daemon.service`

        const statuses = yield* Effect.gen(function*() {
          const service = yield* UserService
          const before = yield* service.status("exangelos.daemon")
          yield* service.install(awkward)
          expect(yield* fs.readFileString(unit)).toBe(renderSystemdUnit(awkward))
          yield* service.start("exangelos.daemon")
          const running = yield* service.status("exangelos.daemon")
          yield* service.stop("exangelos.daemon")
          const stopped = yield* service.status("exangelos.daemon")
          yield* service.uninstall("exangelos.daemon")
          expect(yield* fs.exists(unit)).toBe(false)
          return [before, running, stopped]
        }).pipe(provide(layerSystemd({ directory }), fake))

        expect(statuses).toEqual([
          ServiceStatus.NotInstalled(),
          ServiceStatus.Running({ pid: 4242 }),
          ServiceStatus.Stopped()
        ])
        expect(fake.ran.map(FakeSpawner.line)).toEqual([
          "systemctl --user is-active exangelos.daemon.service",
          "systemctl --user daemon-reload",
          "systemctl --user enable exangelos.daemon.service",
          "systemctl --user start exangelos.daemon.service",
          "systemctl --user is-active exangelos.daemon.service",
          "systemctl --user show -p MainPID --value exangelos.daemon.service",
          "systemctl --user stop exangelos.daemon.service",
          "systemctl --user is-active exangelos.daemon.service",
          "systemctl --user disable --now exangelos.daemon.service",
          "systemctl --user daemon-reload"
        ])
      })
    ))

  it.effect("fails start with systemctl's stderr", () =>
    inTempDirectory((directory) =>
      Effect.gen(function*() {
        const fake = FakeSpawner.make(() => ({
          exitCode: 5,
          stderr: "Failed to start exangelos.daemon.service: Unit exangelos.daemon.service not found.\n"
        }))
        const error = yield* UserService.use((service) => service.start("exangelos.daemon")).pipe(
          provide(layerSystemd({ directory }), fake),
          Effect.flip
        )
        expect(error).toMatchObject({
          _tag: "ServiceFailed",
          operation: "start",
          reason:
            "systemctl --user start exangelos.daemon.service exited with 5: Failed to start exangelos.daemon.service: Unit exangelos.daemon.service not found."
        })
      })
    ))

  it.effect("uninstall stops a starting service and drops its login link after its unit file is gone", () =>
    inTempDirectory((directory) =>
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const link = `${directory}/default.target.wants/exangelos.daemon.service`
        yield* fs.makeDirectory(`${directory}/default.target.wants`)
        yield* fs.symlink(`${directory}/exangelos.daemon.service`, link)
        const fake = FakeSpawner.make(({ args }) => args[1] === "show" ? { stdout: "activating\n" } : {})
        yield* UserService.use((service) => service.uninstall("exangelos.daemon")).pipe(
          provide(layerSystemd({ directory }), fake)
        )
        expect(fake.ran.map(FakeSpawner.line)).toEqual([
          "systemctl --user show -p ActiveState --value exangelos.daemon.service",
          "systemctl --user stop exangelos.daemon.service",
          "systemctl --user daemon-reload"
        ])
        expect(yield* fs.readDirectory(`${directory}/default.target.wants`)).toEqual([])
      })
    ))

  it.effect("refuses a log path that would continue onto the next unit line", () =>
    inTempDirectory((directory) =>
      Effect.gen(function*() {
        const fake = FakeSpawner.make()
        const error = yield* UserService.use((service) =>
          service.install({ ...awkward, stdoutPath: "/tmp/out\\" })
        ).pipe(provide(layerSystemd({ directory }), fake), Effect.flip)
        expect(error).toMatchObject({
          _tag: "ServiceFailed",
          operation: "install",
          reason: "stdoutPath has a line break or a trailing backslash"
        })
        expect(fake.ran).toEqual([])
        expect(yield* (yield* FileSystem.FileSystem).readDirectory(directory)).toEqual([])
      })
    ))
})
