import { DaemonContract } from "@exangelos/contracts"
import { DaemonServer } from "@exangelos/daemon-client"
import { Paths } from "@exangelos/paths"
import * as PluginDirectoryLive from "@exangelos/plugin-directory"
import { StdioPluginRuntime } from "@exangelos/plugin-runtime"
import { Database } from "@exangelos/sqlite"
import { Effect, FileSystem, Layer, Path } from "effect"
import { RpcServer } from "effect/rpc"
import * as Handlers from "./Handlers.ts"
import * as MemoryPluginRepository from "./MemoryPluginRepository.ts"
import * as StartPlugins from "./StartPlugins.ts"

export const DaemonAlreadyRunning = DaemonServer.DaemonAlreadyRunning
export type DaemonAlreadyRunning = DaemonServer.DaemonAlreadyRunning

const database = Layer.unwrap(
  Effect.gen(function*() {
    const paths = yield* Paths.Paths
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    yield* fs.makeDirectory(path.dirname(paths.databaseFile), { recursive: true })
    return Database.layer({ filename: paths.databaseFile })
  })
)

const plugins = StartPlugins.layer.pipe(
  Layer.provideMerge(MemoryPluginRepository.layer),
  Layer.provide(Layer.mergeAll(PluginDirectoryLive.layer, StdioPluginRuntime.layer({ startTimeout: "10 seconds" }), database))
)

export const layer = RpcServer.layer(DaemonContract.DaemonContract, { disableFatalDefects: true }).pipe(
  Layer.provide(Handlers.layer),
  Layer.provide(plugins),
  Layer.provide(DaemonServer.layerFromPaths)
)

export const run = Layer.launch(layer)
