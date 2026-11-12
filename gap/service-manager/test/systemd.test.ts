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
})
