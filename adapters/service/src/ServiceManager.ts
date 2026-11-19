import { Cause, Config, Context, Effect, FileSystem, Layer, Option, Path } from "effect"
import type { ChildProcessSpawner } from "effect/process"
import { ServiceManager } from "@exangelos/application"
import { Paths } from "@exangelos/paths"
import { layerHomebrew, layerLaunchd, layerSystemd, UserService } from "@exangelos/service-manager"
import type { ServiceDefinition, ServiceFailed } from "@exangelos/service-manager"
import { detect, type InstallMethod } from "./InstallMethod.ts"

export const label = "exangelos.daemon"

export interface Options {
  readonly executable: string
  readonly platform: "darwin" | "linux"
  readonly uid: number
}

export class Installation extends Context.Service<Installation, {
  readonly program: string
  readonly install: InstallMethod
  readonly method: ServiceManager.StartMethod
}>()("@exangelos/service/Installation") {}

export const layerInstallation = (
  options: Options
): Layer.Layer<Installation, never, FileSystem.FileSystem | Path.Path> =>
  Layer.effect(
    Installation,
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const executable = (yield* Path.Path).resolve(options.executable)
      const program = yield* fs.realPath(executable).pipe(Effect.orElseSucceed(() => executable))
      const install = detect(program)
      const method: ServiceManager.StartMethod = install._tag === "Homebrew"
        ? "homebrew"
        : options.platform === "darwin"
        ? "launch-agent"
        : "systemd-user"
      return Installation.of({ program, install, method })
    })
  )

export const layerUserService = (
  options: Options
): Layer.Layer<
  UserService,
  Config.ConfigError,
  Installation | ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> =>
  Layer.unwrap(Effect.gen(function*() {
    const { install } = yield* Installation
    const home = yield* Config.NonEmptyString("HOME")
    if (install._tag === "Homebrew") {
      return layerHomebrew({ formula: install.formula, brew: `${install.prefix}/bin/brew` })
    }
    if (options.platform === "darwin") {
      return layerLaunchd({ directory: `${home}/Library/LaunchAgents`, uid: options.uid })
    }
    const configHome = yield* Config.option(Config.NonEmptyString("XDG_CONFIG_HOME"))
    return layerSystemd({ directory: `${Option.getOrElse(configHome, () => `${home}/.config`)}/systemd/user` })
  }))

const forwarded = ["EXANGELOS_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"] as const

const environment = Effect.gen(function*() {
  const entries: Array<[string, string]> = []
  for (const name of forwarded) {
    const value = yield* Config.option(Config.NonEmptyString(name))
    if (Option.isSome(value)) entries.push([name, value.value])
  }
  return Object.fromEntries(entries)
})

export const make = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const paths = yield* Paths.Paths
  const userService = yield* UserService
  const { method, program } = yield* Installation
  const overrides = yield* environment

  const definition: ServiceDefinition = {
    label,
    program,
    arguments: ["daemon"],
    environment: overrides,
    stdoutPath: paths.logFile,
    stderrPath: paths.logFile,
    description: "Exangelos daemon"
  }
  const failed = (reason: string) => new ServiceManager.ServiceFailed({ method, reason })
  const fromUserService = (error: ServiceFailed) => failed(error.reason)

  const installOwnUnit = fs.makeDirectory(paths.logDir, { recursive: true }).pipe(
    Effect.mapError((error) => failed(error.message)),
    Effect.andThen(userService.install(definition).pipe(Effect.mapError(fromUserService)))
  )
  const refuseOverrides = Object.keys(overrides).length === 0
    ? Effect.void
    : Effect.fail(failed(
      `the Homebrew service runs with the formula's environment, so it would not see ${
        Object.keys(overrides).join(", ")
      }; unset them or run exangelos daemon in the foreground`
    ))

  const logged = (action: string) => <A>(effect: Effect.Effect<A, ServiceManager.ServiceFailed>) =>
    effect.pipe(
      Effect.tapError((error) => Effect.logInfo("service action failed", Cause.fail(error))),
      Effect.annotateLogs({ target: label, event: action, startMethod: method })
    )

  return ServiceManager.ServiceManager.of({
    status: userService.status(label).pipe(
      Effect.map((status) => ({
        method,
        installed: status._tag !== "NotInstalled",
        running: status._tag === "Running"
      })),
      Effect.mapError(fromUserService),
      Effect.tap(({ installed, running }) =>
        Effect.logDebug("service status read").pipe(Effect.annotateLogs({ installed, running }))),
      logged("status")
    ),
    install: (method === "homebrew" ? refuseOverrides : installOwnUnit).pipe(
      Effect.tap(() => Effect.logInfo("service installed")),
      logged("install")
    ),
    start: userService.start(label).pipe(
      Effect.mapError(fromUserService),
      Effect.tap(() => Effect.logInfo("service started")),
      logged("start")
    )
  })
})

export const layer: Layer.Layer<
  ServiceManager.ServiceManager,
  Config.ConfigError,
  Installation | UserService | FileSystem.FileSystem | Paths.Paths
> = Layer.effect(ServiceManager.ServiceManager, make)
