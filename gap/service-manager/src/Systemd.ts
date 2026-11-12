import { Effect, FileSystem, Layer, Path } from "effect"
import type { ChildProcessSpawner } from "effect/process"
import {
  commandFailed,
  makeRunner,
  makeUserService,
  type ServiceDefinition,
  ServiceStatus,
  UserService
} from "./UserService.ts"

const escapeSpecifiers = (text: string) => text.replaceAll("%", "%%")

const quote = (text: string) =>
  `"${escapeSpecifiers(text.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"").replaceAll("\n", "\\n"))}"`

const commandWord = (text: string) => quote(text).replaceAll("$", "$$$$")

export const renderSystemdUnit = (definition: ServiceDefinition): string =>
  [
    `[Unit]`,
    `Description=${escapeSpecifiers(definition.description)}`,
    ``,
    `[Service]`,
    `Type=exec`,
    `ExecStart=${[definition.program, ...definition.arguments].map(commandWord).join(" ")}`,
    ...Object.entries(definition.environment).map(([name, value]) => `Environment=${quote(`${name}=${value}`)}`),
    `Restart=on-failure`,
    `StandardOutput=append:${escapeSpecifiers(definition.stdoutPath)}`,
    `StandardError=append:${escapeSpecifiers(definition.stderrPath)}`,
    ``,
    `[Install]`,
    `WantedBy=default.target`,
    ``
  ].join("\n")

export const layerSystemd = (options: {
  readonly directory: string
}): Layer.Layer<
  UserService,
  never,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> =>
  Layer.effect(
    UserService,
    Effect.gen(function*() {
      const run = yield* makeRunner
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const unit = (label: string) => `${label}.service`
      const unitFile = (label: string) => path.join(options.directory, unit(label))
      const systemctl = (...args: ReadonlyArray<string>) => run.succeed("systemctl", ["--user", ...args])
      const isActive = (label: string) =>
        Effect.gen(function*() {
          const args = ["--user", "is-active", unit(label)]
          const output = yield* run.output("systemctl", args)
          const state = output.stdout.trim()
          if (state === "") {
            return yield* commandFailed("systemctl", args, output)
          }
          return state === "active" || state === "reloading"
        })

      return makeUserService({
        install: (definition) =>
          Effect.gen(function*() {
            yield* fs.makeDirectory(options.directory, { recursive: true })
            yield* fs.writeFileString(unitFile(definition.label), renderSystemdUnit(definition))
            yield* systemctl("daemon-reload")
            yield* systemctl("enable", unit(definition.label))
          }),
        start: (label) => Effect.asVoid(systemctl("start", unit(label))),
        stop: (label) => Effect.asVoid(systemctl("stop", unit(label))),
        uninstall: (label) =>
          Effect.gen(function*() {
            if (yield* fs.exists(unitFile(label))) {
              yield* systemctl("disable", "--now", unit(label))
              yield* fs.remove(unitFile(label), { force: true })
            } else if (yield* isActive(label)) {
              yield* systemctl("stop", unit(label))
            } else {
              return
            }
            yield* systemctl("daemon-reload")
          }),
        status: (label) =>
          Effect.gen(function*() {
            if (yield* isActive(label)) {
              const shown = yield* systemctl("show", "-p", "MainPID", "--value", unit(label))
              const pid = Number(shown.stdout.trim())
              return ServiceStatus.Running(Number.isInteger(pid) && pid > 0 ? { pid } : {})
            }
            return (yield* fs.exists(unitFile(label))) ? ServiceStatus.Stopped() : ServiceStatus.NotInstalled()
          })
      })
    })
  )
