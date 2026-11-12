import { resolve } from "node:path"
import { parseArgs } from "node:util"
import { buildPluginArchives } from "../plugin-archives.ts"
import { defaultOfficialPluginsDirectory, officialPluginDirectories } from "../release.ts"

const { values } = parseArgs({
  options: {
    plugins: { type: "string" },
    out: { type: "string", default: defaultOfficialPluginsDirectory }
  }
})

const directories = values.plugins === undefined ? officialPluginDirectories() : values.plugins.split(",").filter((d) => d !== "").map((d) => resolve(d))
const official = await buildPluginArchives(directories, resolve(values.out))
for (const plugin of official) console.log(`${plugin.name} ${plugin.version}: ${plugin.digest}`)
console.log(resolve(values.out))
