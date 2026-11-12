import { mkdirSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { parseArgs } from "node:util"
import { renderCask, renderFormula } from "../homebrew.ts"
import { readChecksums } from "../release-files.ts"
import { defaultReleaseDirectory, packagingDirectory, packagingVersion } from "../release.ts"

const { values } = parseArgs({
  options: {
    release: { type: "string", default: defaultReleaseDirectory },
    version: { type: "string" },
    "base-url": { type: "string" },
    out: { type: "string", default: join(packagingDirectory, "dist", "homebrew-tap") }
  }
})

const releaseDirectory = resolve(values.release)
const release = {
  version: values.version ?? packagingVersion(),
  baseUrl: values["base-url"] ?? pathToFileURL(releaseDirectory).href,
  checksums: readChecksums(releaseDirectory)
}
const out = resolve(values.out)
mkdirSync(join(out, "Formula"), { recursive: true })
mkdirSync(join(out, "Casks"), { recursive: true })
writeFileSync(join(out, "Formula", "exangelos.rb"), renderFormula(release))
writeFileSync(join(out, "Casks", "exangelos-app.rb"), renderCask(release))
console.log(out)
