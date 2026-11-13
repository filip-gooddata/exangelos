import { BunRuntime, BunStdio } from "@effect/platform-bun"
import { Layer } from "effect"
import { FetchHttpClient } from "effect/http"
import { Connector } from "@exangelos/connector-sdk"
import { GitHub, GithubPr } from "./index.ts"

Connector.serve(GithubPr.connector).pipe(
  Layer.provide(GitHub.layer),
  Layer.provide([BunStdio.layer, FetchHttpClient.layer]),
  Layer.launch,
  BunRuntime.runMain
)
