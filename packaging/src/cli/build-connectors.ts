import { resolve } from "node:path"
import { parseArgs } from "node:util"
import { BunRuntime } from "@effect/platform-bun"
import { Console, Effect } from "effect"
import { buildConnectorArchives } from "../connector-archives.ts"
import { defaultOfficialConnectorsDirectory, officialConnectorDirectories } from "../release.ts"
import { bunSpawner } from "../spawner.ts"

const { values } = parseArgs({
  options: {
    connectors: { type: "string" },
    out: { type: "string", default: defaultOfficialConnectorsDirectory }
  }
})

const directories = values.connectors === undefined ? officialConnectorDirectories() : values.connectors.split(",").filter((d) => d !== "").map((d) => resolve(d))
Effect.gen(function*() {
  const official = yield* buildConnectorArchives(directories, resolve(values.out))
  for (const connector of official) yield* Console.log(`${connector.name} ${connector.version}: ${connector.digest}`)
  yield* Console.log(resolve(values.out))
}).pipe(Effect.provide(bunSpawner), BunRuntime.runMain)
