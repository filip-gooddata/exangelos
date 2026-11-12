import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { BunServices } from "@effect/platform-bun"
import { describe, expect, it } from "@effect/vitest"
import { ConfigProvider, Effect, Layer, Option } from "effect"
import {
  layerAlertSink,
  layerSecretStore,
  layerServiceManager,
  layerWakeTarget
} from "@exangelos/application/testing"
import { DaemonClient } from "@exangelos/daemon-client"
import { Paths } from "@exangelos/paths"
import { Daemon } from "@exangelos/daemon"

const home = Effect.acquireRelease(
  Effect.promise(() => Fs.mkdtemp(Path.join(Os.tmpdir(), "exangelos-daemon-"))),
  (dir) => Effect.promise(() => Fs.rm(dir, { recursive: true, force: true }))
)

const withFakes = Daemon.layer({
  alerts: layerAlertSink,
  serviceManager: layerServiceManager({ method: "launch-agent", installed: true, running: true }),
  secretStore: layerSecretStore,
  wakeTarget: layerWakeTarget,
  officialPlugins: [],
  releaseUrl: undefined
})

describe("Daemon", () => {
  it.live("starts with fakes for the platform ports and answers on its socket", () =>
    Effect.gen(function*() {
      const dir = yield* home
      const paths = Paths.layer.pipe(
        Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord({ EXANGELOS_HOME: dir }))),
        Layer.orDie
      )
      const platform = Layer.mergeAll(BunServices.layer, paths)
      const { socketPath, databaseFile } = yield* Effect.provide(Paths.Paths, paths)

      yield* Layer.build(withFakes.pipe(Layer.provide(platform)))

      const plugins = yield* Effect.flatMap(DaemonClient.DaemonClient, (client) => client.ListPlugins()).pipe(
        Effect.provide(DaemonClient.layer({ path: socketPath, session: Option.none() }))
      )
      expect(plugins).toEqual([])
      yield* Effect.promise(() => Fs.access(databaseFile))
    }).pipe(Effect.scoped))
})
