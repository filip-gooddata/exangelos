import { $ } from "bun"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { parseArgs } from "node:util"

const { values } = parseArgs({
  options: {
    target: { type: "string" },
    outfile: { type: "string" },
    version: { type: "string" },
    "official-plugins": { type: "string" }
  }
})

const outfile = values.outfile === undefined
  ? join(import.meta.dir, "dist", values.target === undefined ? "exangelos" : `exangelos-${values.target}`)
  : resolve(values.outfile)
const defines = [
  ...(values.version === undefined ? [] : ["--define", `EXANGELOS_VERSION=${JSON.stringify(values.version)}`]),
  ...(values["official-plugins"] === undefined ? [] : ["--define", `EXANGELOS_OFFICIAL_PLUGINS=${values["official-plugins"]}`])
]
const target = values.target === undefined ? [] : [`--target=${values.target}`]
const scratch = await mkdtemp(join(tmpdir(), "exangelos-build-"))

try {
  await $`bun build ${join(import.meta.dir, "src/main.ts")} --compile --no-compile-autoload-dotenv --no-compile-autoload-bunfig ${target} ${defines} --outfile ${outfile}`
    .cwd(scratch)
} finally {
  await rm(scratch, { recursive: true, force: true })
}
