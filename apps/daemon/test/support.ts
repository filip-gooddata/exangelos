import { execFile } from "node:child_process"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { promisify } from "node:util"
import { BunServices } from "@effect/platform-bun"
import { ConfigProvider, Context, Duration, Effect, Exit, Layer, Option, Schedule, Scope } from "effect"
import {
  layerAlertSink,
  layerSecretStore,
  layerServiceManager,
  layerWakeTarget
} from "@exangelos/application/testing"
import { DaemonClient } from "@exangelos/daemon-client"
import type { Limits, Session } from "@exangelos/domain"
import { Paths } from "@exangelos/paths"
import { Daemon } from "@exangelos/daemon"

const run = promisify(execFile)

const template = Path.resolve(import.meta.dirname, "../../../plugins/template")

export const home = Effect.acquireRelease(
  Effect.promise(() => Fs.mkdtemp(Path.join(Os.tmpdir(), "exangelos-daemon-"))),
  (dir) => Effect.promise(() => Fs.rm(dir, { recursive: true, force: true }))
)

/** A runnable copy of plugins/template under `name`, bundled with the Bun that runs the tests. */
export const templatePlugin = (into: string, name = "template") =>
  Effect.promise(async () => {
    const directory = Path.join(into, name)
    await run(process.execPath, [
      "build",
      Path.join(template, "src/main.ts"),
      "--target=bun",
      `--outfile=${Path.join(directory, "dist/main.js")}`
    ], { env: { ...process.env, BUN_BE_BUN: "1" } })
    const manifest = JSON.parse(await Fs.readFile(Path.join(template, "plugin.json"), "utf8"))
    await Fs.writeFile(Path.join(directory, "plugin.json"), JSON.stringify({ ...manifest, name }))
    return directory
  })

/** Appends each wake's subscription id and text to `file`. */
export const wakeLog = (file: string) =>
  ["/bin/sh", "-c", "{ printf '%s\\n' \"$EXANGELOS_SUBSCRIPTION\"; cat; } >> \"$0\"", file] as const

type Choices = Pick<Daemon.Options, "alerts" | "serviceManager" | "secretStore" | "wakeTarget">

export const fakes: Choices = {
  alerts: layerAlertSink,
  serviceManager: layerServiceManager({ method: "launch-agent", installed: true, running: true }),
  secretStore: layerSecretStore,
  wakeTarget: layerWakeTarget
}

export interface Running {
  readonly client: DaemonClient.DaemonClient["Service"]
  readonly as: (session: Session.Session) => Effect.Effect<DaemonClient.DaemonClient["Service"]>
  readonly stop: Effect.Effect<void>
}

/** Starts the daemon on the temporary home and connects an owner client to its socket. */
export const start = (
  dir: string,
  options: Partial<Choices> & { readonly officialPlugins?: ReadonlyArray<unknown>; readonly releaseUrl?: string } = {}
): Effect.Effect<Running, never, Scope.Scope> =>
  Effect.gen(function*() {
    const paths = Paths.layer.pipe(
      Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord({ EXANGELOS_HOME: dir }))),
      Layer.orDie
    )
    const platform = Layer.mergeAll(BunServices.layer, paths)
    const { socketPath } = yield* Effect.provide(Paths.Paths, paths)
    const daemon = Daemon.layer({
      ...fakes,
      ...options,
      officialPlugins: options.officialPlugins ?? [],
      releaseUrl: options.releaseUrl
    }).pipe(Layer.provide(platform))

    const scope = yield* Scope.make()
    yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
    yield* Layer.buildWithScope(daemon, scope).pipe(Effect.orDie)
    const connect = (session: Option.Option<Session.Session>) =>
      Layer.buildWithScope(DaemonClient.layer({ path: socketPath, session }), scope).pipe(
        Effect.map(Context.get(DaemonClient.DaemonClient)),
        Effect.orDie
      )
    return {
      client: yield* connect(Option.none()),
      as: (session) => connect(Option.some(session)),
      stop: Scope.close(scope, Exit.void)
    }
  })

/** Shortens the wake window so a wake follows its first event within the delivery loop's second. */
export const quickWakes = (client: Running["client"], change: Partial<Limits.Limits> = {}) =>
  Effect.gen(function*() {
    const settings = yield* client.GetSettings()
    yield* client.SetSettings({
      settings: { ...settings, limits: { ...settings.limits, wakeWindow: Duration.zero, ...change } }
    })
  })

/** Imports the template from a local directory, enables it and gives it the configuration it asks for. */
export const installTemplate = (client: Running["client"], dir: string) =>
  Effect.gen(function*() {
    const source = yield* templatePlugin(Path.join(dir, "sources"))
    const imported = yield* client.ImportPlugin({ source: { _tag: "Directory", path: source } })
    yield* client.EnablePlugin({ name: imported.name, digest: imported.digest })
    yield* client.ConfigurePlugin({ name: imported.name, values: { token: "not-a-secret", interval: "0" } }).pipe(
      Effect.retry({ schedule: Schedule.spaced(Duration.millis(100)) }),
      Effect.timeout(Duration.seconds(15))
    )
    return imported
  })

/** Retries `check` until it succeeds, failing the test after `limit`. */
export const eventually = <A, E, R>(check: Effect.Effect<A, E, R>, limit = Duration.seconds(20)) =>
  check.pipe(
    Effect.retry({ schedule: Schedule.spaced(Duration.millis(100)) }),
    Effect.timeout(limit)
  )
