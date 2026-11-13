import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
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

const scratch = mkdtempSync(join(tmpdir(), "xng-stand-in-build-"))
try {
  execFileSync(
    process.execPath,
    [
      "build",
      join(import.meta.dirname, "stand-in-entry.ts"),
      "--compile",
      `--target=${values.target}`,
      `--define=EXANGELOS_VERSION=${JSON.stringify(values.version)}`,
      `--define=EXANGELOS_OFFICIAL_CONNECTORS=${values["official-connectors"]}`,
      `--define=EXANGELOS_RELEASE_URL=${JSON.stringify(values["release-url"])}`,
      `--outfile=${values.outfile}`
    ],
    { cwd: scratch, stdio: ["ignore", "ignore", "inherit"] }
  )
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
