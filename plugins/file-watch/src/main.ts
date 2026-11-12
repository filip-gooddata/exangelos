import { BunFileSystem, BunRuntime, BunStdio } from "@effect/platform-bun"
import { Layer } from "effect"
import { Plugin } from "@exangelos/plugin-sdk"
import { FileWatch } from "./index.ts"

Plugin.serve(FileWatch.plugin).pipe(
  Layer.provide([BunStdio.layer, BunFileSystem.layer]),
  Layer.launch,
  BunRuntime.runMain
)
