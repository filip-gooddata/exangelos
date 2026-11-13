import { BunRuntime, BunStdio } from "@effect/platform-bun"
import { Layer } from "effect"
import { Connector } from "@exangelos/connector-sdk"
import { Template } from "./index.ts"

Connector.serve(Template.connector).pipe(Layer.provide(BunStdio.layer), Layer.launch, BunRuntime.runMain)
