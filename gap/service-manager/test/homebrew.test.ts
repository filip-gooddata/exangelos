import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { layerHomebrew, ServiceStatus, UserService } from "@exangelos/service-manager"
import * as FakeSpawner from "./FakeSpawner.ts"
import { awkward, provide } from "./support.ts"

const info = (running: boolean, pid: number | null) =>
  JSON.stringify([{ name: "exangelos", service_name: "homebrew.mxcl.exangelos", running, loaded: running, pid }])

describe("layerHomebrew", () => {
  it.effect("leaves the definition to the formula and drives brew services", () =>
    Effect.gen(function*() {
      let running = false
      const fake = FakeSpawner.make(({ args }) => {
        switch (args[1]) {
          case "start":
            running = true
            return {}
          case "kill":
          case "stop":
            running = false
            return {}
          case "info":
            return { stdout: info(running, running ? 4242 : null) }
          default:
            return {}
        }
      })

      const statuses = yield* Effect.gen(function*() {
        const service = yield* UserService
        yield* service.install(awkward)
        const installed = yield* service.status("exangelos.daemon")
        yield* service.start("exangelos.daemon")
        const started = yield* service.status("exangelos.daemon")
        yield* service.stop("exangelos.daemon")
        yield* service.uninstall("exangelos.daemon")
        return [installed, started]
      }).pipe(provide(layerHomebrew({ formula: "exangelos" }), fake))

      expect(statuses).toEqual([ServiceStatus.Stopped(), ServiceStatus.Running({ pid: 4242 })])
      expect(fake.ran.map(FakeSpawner.line)).toEqual([
        "brew services info --json exangelos",
        "brew services start exangelos",
        "brew services info --json exangelos",
        "brew services kill exangelos",
        "brew services stop exangelos"
      ])
    }))

  it.effect("reports a formula Homebrew does not know as not installed", () =>
    UserService.use((service) => service.status("exangelos.daemon")).pipe(
      provide(
        layerHomebrew({ formula: "exangelos" }),
        FakeSpawner.make(() => ({
          exitCode: 1,
          stderr: "Error: No available formula with the name \"exangelos\".\n"
        }))
      ),
      Effect.map((status) => expect(status).toEqual(ServiceStatus.NotInstalled()))
    ))

  it.effect("fails start with brew's stderr", () =>
    Effect.gen(function*() {
      const fake = FakeSpawner.make(() => ({ exitCode: 1, stderr: "Error: Failure while executing launchctl\n" }))
      const error = yield* UserService.use((service) => service.start("exangelos.daemon")).pipe(
        provide(layerHomebrew({ formula: "exangelos" }), fake),
        Effect.flip
      )
      expect(error).toMatchObject({
        _tag: "ServiceFailed",
        operation: "start",
        reason: "brew services start exangelos exited with 1: Error: Failure while executing launchctl"
      })
    }))
})
