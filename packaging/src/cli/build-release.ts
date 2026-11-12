import { resolve } from "node:path"
import { parseArgs } from "node:util"
import { findTarget, targets } from "../release-files.ts"
import {
  buildRelease,
  defaultBuildScript,
  defaultOfficialPluginsDirectory,
  defaultReleaseDirectory,
  describeRelease,
  officialPluginDirectories,
  packagingVersion
} from "../release.ts"

const { values } = parseArgs({
  options: {
    "build-script": { type: "string" },
    version: { type: "string" },
    plugins: { type: "string" },
    targets: { type: "string" },
    "official-plugins-out": { type: "string", default: defaultOfficialPluginsDirectory },
    out: { type: "string", default: defaultReleaseDirectory }
  }
})

const release = await buildRelease({
  buildScript: values["build-script"] === undefined ? defaultBuildScript : resolve(values["build-script"]),
  version: values.version ?? packagingVersion(),
  pluginDirectories:
    values.plugins === undefined ? officialPluginDirectories() : values.plugins.split(",").filter((d) => d !== "").map((d) => resolve(d)),
  officialPluginsDirectory: resolve(values["official-plugins-out"]),
  releaseDirectory: resolve(values.out),
  targets: values.targets === undefined ? targets : values.targets.split(",").map(findTarget)
})
console.log(describeRelease(release))
