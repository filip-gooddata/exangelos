import { BunRuntime, BunStdio } from "@effect/platform-bun"
import { Layer } from "effect"
import { FetchHttpClient } from "effect/http"
import { Plugin } from "@exangelos/plugin-sdk"
import { GitHub, GithubPr } from "./index.ts"

Plugin.serve(GithubPr.plugin).pipe(
  Layer.provide(GitHub.layer),
  Layer.provide([BunStdio.layer, FetchHttpClient.layer]),
  Layer.launch,
  BunRuntime.runMain
)
