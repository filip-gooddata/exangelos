import { execFile } from "node:child_process"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

const run = promisify(execFile)

export async function localAppIcon(bundleIds: ReadonlyArray<string>, maxBytes: number, signal: AbortSignal) {
  if (process.platform !== "darwin") return undefined
  try {
    const script = fileURLToPath(new URL("./local-app-icon.js", import.meta.url))
    const { stdout } = await run("/usr/bin/osascript", ["-l", "JavaScript", script, String(maxBytes), ...bundleIds], {
      maxBuffer: 4 * Math.ceil(maxBytes / 3) + 2,
      // Leave time to return the PNG within the daemon's ten-second Icon deadline.
      timeout: 8000,
      killSignal: "SIGKILL",
      signal
    })
    const bytes = Buffer.from(stdout.trim(), "base64")
    if (bytes.length && bytes.length <= maxBytes) return { mediaType: "image/png" as const, bytes }
  } catch {
    // An unavailable renderer or an oversized icon uses the panel's initials.
  }
  return undefined
}
