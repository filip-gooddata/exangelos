import { spawnSync } from "node:child_process"
import { join } from "node:path"
import { parseArgs } from "node:util"

const bunTargets: Record<string, string> = {
  "aarch64-apple-darwin": "bun-darwin-arm64",
  "x86_64-apple-darwin": "bun-darwin-x64",
  "aarch64-unknown-linux-gnu": "bun-linux-arm64",
  "x86_64-unknown-linux-gnu": "bun-linux-x64"
}

const hostTriples: Record<string, string> = {
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
  "linux-arm64": "aarch64-unknown-linux-gnu",
  "linux-x64": "x86_64-unknown-linux-gnu"
}

const { values } = parseArgs({ options: { target: { type: "string" }, version: { type: "string" } } })

const triple = values.target ?? process.env.TAURI_ENV_TARGET_TRIPLE ?? hostTriples[`${process.platform}-${process.arch}`]
const bunTarget = triple === undefined ? undefined : bunTargets[triple]
if (triple === undefined || bunTarget === undefined) {
  console.error(`No Exangelos sidecar build for target ${triple ?? `${process.platform}-${process.arch}`}`)
  process.exit(1)
}

const outfile = join(import.meta.dirname, "src-tauri", "binaries", `exangelos-${triple}`)
const result = spawnSync(
  "bun",
  [
    join(import.meta.dirname, "../cli/build.ts"),
    `--target=${bunTarget}`,
    `--outfile=${outfile}`,
    ...(values.version === undefined ? [] : [`--version=${values.version}`])
  ],
  { stdio: "inherit" }
)
process.exit(result.status ?? 1)
