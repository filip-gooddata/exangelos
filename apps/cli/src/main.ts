import { SessionHeaders } from "@exangelos/contracts"
import { Paths } from "@exangelos/paths"
import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Effect, Layer, Stdio } from "effect"
import { CliOutput } from "effect/cli"
import * as Build from "./Build.ts"
import * as Entry from "./Entry.ts"

const formatter = CliOutput.layer({
  ...CliOutput.defaultFormatter({ colors: false }),
  formatVersion: (name, version) => `${name} ${version}`
})

const client = Entry.daemonClient(
  SessionHeaders.detect(process.env),
  Entry.serviceManager({
    executable: process.execPath,
    platform: process.platform === "darwin" ? "darwin" : "linux",
    uid: process.getuid?.() ?? 0
  })
)

Stdio.Stdio.use(({ args }) => Effect.flatMap(args, Entry.run({ version: Build.version, client }))).pipe(
  Effect.provide(Layer.mergeAll(formatter, Paths.layer, BunServices.layer)),
  BunRuntime.runMain({ disableErrorReporting: true })
)
