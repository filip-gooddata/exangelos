import { BunRuntime, BunStdio } from "@effect/platform-bun"
import { Layer } from "effect"
import { FetchHttpClient } from "effect/http"
import { Connector } from "@exangelos/connector-sdk"
import { JiraClient, JiraConnector } from "./index.ts"

const jira = JiraConnector.connector.layer.pipe(Layer.provide(JiraClient.layer), Layer.provide(FetchHttpClient.layer))

Connector.serve({ layer: jira }).pipe(Layer.provide(BunStdio.layer), Layer.launch, BunRuntime.runMain)
