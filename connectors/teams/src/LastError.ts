import { closeSync, constants, fstatSync, mkdirSync, openSync, renameSync, unlinkSync, writeFileSync, statSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { homedir } from "node:os"
import { isAbsolute, join } from "node:path"
import { fileURLToPath } from "node:url"

const modules = new Set(["bridge", "current_store", "native_cache", "serialization", "probe",
  "idb_comparator", "reactions", "state_directory", "excerpt"])
const exceptions = new Set(["Invalid", "Refusal", "ReadDeadline", "ValueError", "TypeError", "KeyError",
  "IndexError", "AttributeError", "UnicodeDecodeError", "FileNotFoundError", "PermissionError",
  "NotADirectoryError", "OSError", "MemoryError", "OverflowError", "RecursionError", "ImportError",
  "ModuleNotFoundError", "JSONDecodeError", "Other"])

export const childDetail = (text: string) => {
  if (text.length > 512) return undefined
  try {
    const value = JSON.parse(text)
    if (!value || !exceptions.has(value.exception) || !Array.isArray(value.frames) || value.frames.length > 3 ||
      !value.frames.every((f: unknown) => Array.isArray(f) && f.length === 2 && modules.has(f[0]) &&
        Number.isInteger(f[1]) && f[1] > 0 && f[1] <= 65535) ||
      !(value.errno === null || (Number.isInteger(value.errno) && value.errno > 0 && value.errno <= 255))) return undefined
    return { exception: value.exception as string, frames: value.frames as [string, number][], errno: value.errno as number | null }
  } catch { return undefined }
}

export type Operation = "resolve" | "configured-snapshot"
export interface Outcome {
  stage: "spawn" | "exit" | "stdin" | "stdout" | "output-limit" | "utf8" | "json" | "schema" | "deadline"
  exception?: "PlatformError" | "TimeoutError" | "TypeError" | "SyntaxError" | "SchemaError"
  exitCode?: number
  signal?: string
  errno?: string
  child?: ReturnType<typeof childDetail>
}

const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW

// Keep each directory open while descending, including across mkdir and the final rename.
const writePrivate = (root: string, record: string) => {
  if (!isAbsolute(root) || root.split("/").includes("..") || !["darwin", "linux"].includes(process.platform)) return
  const installed = statSync(fileURLToPath(new URL("..", import.meta.url)), { bigint: true })
  const uid = BigInt(process.getuid!())
  const parts = [...root.split("/").filter(Boolean), "connector-state", "teams"]
  let fd = openSync("/", flags)
  try {
    for (let index = 0; ; index++) {
      const st = fstatSync(fd, { bigint: true })
      if (st.dev === installed.dev && st.ino === installed.ino) return
      if ((st.uid !== 0n && st.uid !== uid) ||
        ((st.mode & 0o022n) !== 0n && !(st.uid === 0n && (st.mode & 0o1000n) !== 0n))) return
      const directory = process.platform === "darwin" ? `/.vol/${st.dev}/${st.ino}` : `/proc/self/fd/${fd}`
      if (index === parts.length) {
        if (st.uid !== uid || (st.mode & 0o777n) !== 0o700n) return
        const temp = join(directory, `.last-error-${randomUUID()}`)
        const file = openSync(temp, constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_WRONLY, 0o600)
        try {
          try { writeFileSync(file, record) } finally { closeSync(file) }
          renameSync(temp, join(directory, "last-error.json"))
        } finally { try { unlinkSync(temp) } catch {} }
        return
      }
      const path = join(directory, parts[index]!)
      let next
      try {
        next = openSync(path, flags)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
        try { mkdirSync(path, { mode: 0o700 }) } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e }
        next = openSync(path, flags)
      }
      closeSync(fd)
      fd = next
    }
  } finally { closeSync(fd) }
}

export const recordFailure = (operation: Operation, started: { wall: number; monotonic: number }, outcome: Outcome) => {
  try {
    const root = process.env.EXANGELOS_HOME || `${process.env.XDG_DATA_HOME || join(homedir(), ".local/share")}/exangelos`
    writePrivate(root, JSON.stringify({ version: 1, operation, at: new Date().toISOString(),
      wallMs: Math.max(0, Date.now() - started.wall), elapsedMs: Math.max(0, Math.round(performance.now() - started.monotonic)), ...outcome }) + "\n")
  } catch { /* Reporting is best effort and must preserve the source failure. */ }
}
