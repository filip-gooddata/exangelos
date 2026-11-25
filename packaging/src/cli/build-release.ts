import { resolve } from "node:path"
import { parseArgs } from "node:util"
import { BunRuntime } from "@effect/platform-bun"
import { Console, Effect } from "effect"
import { findTarget, targets } from "../release-files.ts"
import {
  buildRelease,
  defaultBuildScript,
  defaultOfficialConnectorsDirectory,
  defaultReleaseDirectory,
  describeRelease,
  officialConnectorDirectories,
  packagingVersion
} from "../release.ts"
import { bunSpawner } from "../spawner.ts"

const { values } = parseArgs({
  options: {
    "build-script": { type: "string" },
    version: { type: "string" },
    "release-url": { type: "string" },
    connectors: { type: "string" },
    targets: { type: "string" },
    "official-connectors-out": { type: "string", default: defaultOfficialConnectorsDirectory },
    out: { type: "string", default: defaultReleaseDirectory }
  }
})

const releaseUrl = values["release-url"]
if (releaseUrl === undefined || releaseUrl === "") {
  console.error("build-release needs --release-url <url>: the address the binary fetches official connector archives from")
  process.exit(2)
}

buildRelease({
  releaseUrl,
  buildScript: values["build-script"] === undefined ? defaultBuildScript : resolve(values["build-script"]),
  version: values.version ?? packagingVersion(),
  connectorDirectories:
    values.connectors === undefined ? officialConnectorDirectories() : values.connectors.split(",").filter((d) => d !== "").map((d) => resolve(d)),
  officialConnectorsDirectory: resolve(values["official-connectors-out"]),
  releaseDirectory: resolve(values.out),
  targets: values.targets === undefined ? targets : values.targets.split(",").map(findTarget)
}).pipe(
  Effect.flatMap((release) => Console.log(describeRelease(release))),
  Effect.provide(bunSpawner),
  BunRuntime.runMain
)
