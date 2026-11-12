import { Effect, Layer } from "effect"
import type { ChildProcessSpawner } from "effect/process"
import { CommandFailed, commandFailed, makeRunner, makeUserService, ServiceStatus, UserService } from "./UserService.ts"

interface Info {
  readonly running?: boolean
  readonly pid?: number | null
}

const parseInfo = (stdout: string) =>
  Effect.try({
    try: () => (JSON.parse(stdout) as ReadonlyArray<Info>)[0],
    catch: () => new CommandFailed({ reason: `brew services info printed no JSON: ${stdout.trim()}` })
  })

export const layerHomebrew = (options: {
  readonly formula: string
}): Layer.Layer<UserService, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Layer.effect(
    UserService,
    Effect.gen(function*() {
      const run = yield* makeRunner
      const services = (command: string) => Effect.asVoid(run.succeed("brew", ["services", command, options.formula]))

      return makeUserService({
        install: () => Effect.void,
        start: () => services("start"),
        stop: () => services("kill"),
        uninstall: () => services("stop"),
        status: () =>
          Effect.gen(function*() {
            const args = ["services", "info", "--json", options.formula]
            const output = yield* run.output("brew", args)
            if (output.exitCode !== 0) {
              if (output.stderr.includes("No available formula")) {
                return ServiceStatus.NotInstalled()
              }
              return yield* commandFailed("brew", args, output)
            }
            const info = yield* parseInfo(output.stdout)
            if (info?.running !== true) {
              return ServiceStatus.Stopped()
            }
            return ServiceStatus.Running(typeof info.pid === "number" ? { pid: info.pid } : {})
          })
      })
    })
  )
