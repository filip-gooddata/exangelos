import { resolve } from "node:path"
import { parseArgs } from "node:util"
import { BunRuntime } from "@effect/platform-bun"
import { Console, Effect } from "effect"
import { buildPluginArchives } from "../plugin-archives.ts"
import { defaultOfficialPluginsDirectory, officialPluginDirectories } from "../release.ts"
import { bunSpawner } from "../spawner.ts"

const { values } = parseArgs({
  options: {
    plugins: { type: "string" },
    out: { type: "string", default: defaultOfficialPluginsDirectory }
  }
})

const directories = values.plugins === undefined ? officialPluginDirectories() : values.plugins.split(",").filter((d) => d !== "").map((d) => resolve(d))
Effect.gen(function*() {
  const official = yield* buildPluginArchives(directories, resolve(values.out))
  for (const plugin of official) yield* Console.log(`${plugin.name} ${plugin.version}: ${plugin.digest}`)
  yield* Console.log(resolve(values.out))
}).pipe(Effect.provide(bunSpawner), BunRuntime.runMain)
