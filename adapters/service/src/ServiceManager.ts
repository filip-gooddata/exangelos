import { Config, Effect, FileSystem, Layer, Option } from "effect"
import type { Path } from "effect"
import type { ChildProcessSpawner } from "effect/process"
import { ServiceManager } from "@exangelos/application"
import { Paths } from "@exangelos/paths"
import { layerHomebrew, layerLaunchd, layerSystemd, UserService } from "@exangelos/service-manager"
import type { ServiceDefinition, ServiceFailed } from "@exangelos/service-manager"
import { detect } from "./InstallMethod.ts"

export const label = "exangelos.daemon"

export interface Options {
  readonly executable: string
  readonly platform: "darwin" | "linux"
  readonly uid: number
}

const forwarded = ["EXANGELOS_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"] as const

const environment = Effect.gen(function*() {
  const entries: Array<[string, string]> = []
  for (const name of forwarded) {
    const value = yield* Config.option(Config.NonEmptyString(name))
    if (Option.isSome(value)) entries.push([name, value.value])
  }
  return Object.fromEntries(entries)
})

const make = (options: Options) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const paths = yield* Paths.Paths
    const home = yield* Config.NonEmptyString("HOME")
    const configHome = yield* Config.option(Config.NonEmptyString("XDG_CONFIG_HOME"))
    const program = yield* fs.realPath(options.executable).pipe(Effect.orElseSucceed(() => options.executable))
    const install = detect(program)

    const [method, userServiceLayer] = install._tag === "Homebrew"
      ? ["homebrew", layerHomebrew({ formula: install.formula })] as const
      : options.platform === "darwin"
      ? ["launch-agent", layerLaunchd({ directory: `${home}/Library/LaunchAgents`, uid: options.uid })] as const
      : [
        "systemd-user",
        layerSystemd({ directory: `${Option.getOrElse(configHome, () => `${home}/.config`)}/systemd/user` })
      ] as const
    const userService = yield* Effect.provide(UserService, userServiceLayer)

    const definition: ServiceDefinition = {
      label,
      program,
      arguments: ["daemon"],
      environment: yield* environment,
      stdoutPath: paths.logFile,
      stderrPath: paths.logFile,
      description: "Exangelos daemon"
    }
    const failed = (reason: string) => new ServiceManager.ServiceFailed({ method, reason })
    const fromUserService = (error: ServiceFailed) => failed(error.reason)

    return ServiceManager.ServiceManager.of({
      status: userService.status(label).pipe(
        Effect.map((status) => ({
          method,
          installed: status._tag !== "NotInstalled",
          running: status._tag === "Running"
        })),
        Effect.mapError(fromUserService)
      ),
      install: method === "homebrew" ? Effect.void : fs.makeDirectory(paths.logDir, { recursive: true }).pipe(
        Effect.mapError((error) => failed(error.message)),
        Effect.andThen(userService.install(definition).pipe(Effect.mapError(fromUserService)))
      ),
      start: userService.start(label).pipe(Effect.mapError(fromUserService))
    })
  })

export const layer = (
  options: Options
): Layer.Layer<
  ServiceManager.ServiceManager,
  Config.ConfigError,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path | Paths.Paths
> => Layer.effect(ServiceManager.ServiceManager, make(options))
