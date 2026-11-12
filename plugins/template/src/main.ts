import { BunRuntime, BunStdio } from "@effect/platform-bun"
import { Layer } from "effect"
import { Plugin } from "@exangelos/plugin-sdk"
import { Template } from "./index.ts"

Plugin.serve(Template.plugin).pipe(Layer.provide(BunStdio.layer), Layer.launch, BunRuntime.runMain)
