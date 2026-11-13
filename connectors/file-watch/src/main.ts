import { BunFileSystem, BunRuntime, BunStdio } from "@effect/platform-bun"
import { Layer } from "effect"
import { Connector } from "@exangelos/connector-sdk"
import { FileWatch } from "./index.ts"

Connector.serve(FileWatch.connector).pipe(
  Layer.provide([BunStdio.layer, BunFileSystem.layer]),
  Layer.launch,
  BunRuntime.runMain
)
