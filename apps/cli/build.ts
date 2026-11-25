import { $ } from "bun"
import { readdirSync, readFileSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, relative, resolve, sep } from "node:path"
import { parseArgs } from "node:util"

const { values } = parseArgs({
  options: {
    target: { type: "string" },
    outfile: { type: "string" },
    version: { type: "string" },
    "official-connectors": { type: "string" },
    "release-url": { type: "string" }
  }
})

const outfile = values.outfile === undefined
  ? join(import.meta.dir, "dist", values.target === undefined ? "exangelos" : `exangelos-${values.target}`)
  : resolve(values.outfile)
const templateDirectory = join(import.meta.dir, "../../connectors/template")
const skipped = new Set(["node_modules", ".turbo", "dist"])
const template = Object.fromEntries(
  readdirSync(templateDirectory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(templateDirectory, join(entry.parentPath, entry.name)))
    .filter((file) => !file.split(sep).some((segment) => skipped.has(segment)))
    .map((file) => [file, readFileSync(join(templateDirectory, file), "utf8")])
)
const skill = readFileSync(join(import.meta.dir, "../../skills/exangelos/SKILL.md"), "utf8")
const defines = [
  "--define",
  `EXANGELOS_CONNECTOR_TEMPLATE=${JSON.stringify(template)}`,
  "--define",
  `EXANGELOS_SKILL=${JSON.stringify(skill)}`,
  ...(values.version === undefined ? [] : ["--define", `EXANGELOS_VERSION=${JSON.stringify(values.version)}`]),
  ...(values["official-connectors"] === undefined ? [] : ["--define", `EXANGELOS_OFFICIAL_CONNECTORS=${values["official-connectors"]}`]),
  ...(values["release-url"] === undefined ? [] : ["--define", `EXANGELOS_RELEASE_URL=${JSON.stringify(values["release-url"])}`])
]
const target = values.target === undefined ? [] : [`--target=${values.target}`]
const scratch = await mkdtemp(join(tmpdir(), "exangelos-build-"))

try {
  await $`bun build ${join(import.meta.dir, "src/main.ts")} --compile --no-compile-autoload-dotenv --no-compile-autoload-bunfig ${target} ${defines} --outfile ${outfile}`
    .cwd(scratch)
} finally {
  await rm(scratch, { recursive: true, force: true })
}
