import { BunChildProcessSpawner, BunFileSystem, BunPath, BunRuntime, BunStdio } from "@effect/platform-bun"
import { Layer } from "effect"
import { Connector } from "@exangelos/connector-sdk"
import { Teams } from "./index.ts"

Connector.serve(Teams.connector).pipe(
  Layer.provide(Layer.merge(BunStdio.layer, BunChildProcessSpawner.layer.pipe(Layer.provide(Layer.merge(BunFileSystem.layer, BunPath.layer))))),
  Layer.launch,
  BunRuntime.runMain
)
