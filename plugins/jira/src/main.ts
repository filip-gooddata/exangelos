import { BunRuntime, BunStdio } from "@effect/platform-bun"
import { Layer } from "effect"
import { FetchHttpClient } from "effect/http"
import { Plugin } from "@exangelos/plugin-sdk"
import { JiraClient, JiraPlugin } from "./index.ts"

const jira = JiraPlugin.plugin.layer.pipe(Layer.provide(JiraClient.layer), Layer.provide(FetchHttpClient.layer))

Plugin.serve({ layer: jira }).pipe(Layer.provide(BunStdio.layer), Layer.launch, BunRuntime.runMain)
