import * as Fs from "node:fs/promises"
import * as Path from "node:path"
import { Schema } from "effect"

/** Limits on what one import may bring in. */
export const limits = {
  downloadBytes: 64 * 1024 * 1024,
  extractedBytes: 256 * 1024 * 1024,
  entries: 10_000
} as const

/** A refusal: the reason is shown to the owner as is. */
export class Refused extends Schema.TaggedError<Refused>()("Refused", { reason: Schema.String }) {}

export type Kind = "file" | "directory" | "link" | "special"

export interface Entry {
  readonly path: string
  readonly kind: Kind
  readonly size: number
}

/**
 * The relative path an archive entry names, with `/` separators and no `.` segments. Refuses an
 * absolute path, a drive letter, a backslash, a NUL and a `..` segment.
 */
export const safePath = (raw: string): string => {
  if (raw.includes("\0")) throw new Refused({ reason: `the entry ${JSON.stringify(raw)} contains a NUL character` })
  if (raw.includes("\\")) throw new Refused({ reason: `the entry ${raw} contains a backslash` })
  if (raw.startsWith("/") || /^[A-Za-z]:/.test(raw)) throw new Refused({ reason: `the entry ${raw} is an absolute path` })
  const segments = raw.split("/").filter((segment) => segment !== "" && segment !== ".")
  if (segments.includes("..")) throw new Refused({ reason: `the entry ${raw} has a .. segment` })
  if (segments.length === 0) throw new Refused({ reason: `the entry ${JSON.stringify(raw)} names no file` })
  return segments.join("/")
}

const collisionKey = (path: string) => path.normalize("NFC").toLowerCase()

/**
 * Checks every entry before anything is written: only files and directories, within the limits,
 * no path twice under case and Unicode folding, and no entry below a file.
 */
export const preflight = (entries: ReadonlyArray<Entry>): ReadonlyArray<Entry> => {
  if (entries.length > limits.entries) throw new Refused({ reason: `the archive has more than ${limits.entries} entries` })
  const seen = new Map<string, Kind>()
  let total = 0
  const checked = entries.map((entry) => {
    if (entry.kind === "directory" && /^(\.?\/)*\.?$/.test(entry.path)) return { ...entry, path: "" }
    const path = safePath(entry.path)
    if (entry.kind === "link") throw new Refused({ reason: `the entry ${path} is a link, and links are refused` })
    if (entry.kind === "special") throw new Refused({ reason: `the entry ${path} is a device or another special file` })
    total += entry.size
    if (total > limits.extractedBytes) throw new Refused({ reason: `the archive unpacks to more than ${limits.extractedBytes} bytes` })
    const key = collisionKey(path)
    const earlier = seen.get(key)
    if (earlier !== undefined && (earlier === "file" || entry.kind === "file")) {
      throw new Refused({ reason: `the entry ${path} appears twice` })
    }
    seen.set(key, entry.kind)
    return { ...entry, path }
  })
  for (const entry of checked) {
    if (entry.path === "") continue
    const segments = collisionKey(entry.path).split("/")
    for (let end = 1; end < segments.length; end++) {
      if (seen.get(segments.slice(0, end).join("/")) === "file") {
        throw new Refused({ reason: `the entry ${entry.path} passes through a file` })
      }
    }
  }
  return checked
}

/** Counts files and bytes against the limits while a tree is copied or walked. */
const budget = () => {
  let count = 0
  let total = 0
  return {
    entry: () => {
      if (++count > limits.entries) throw new Refused({ reason: `the connector has more than ${limits.entries} files` })
    },
    bytes: (size: number) => {
      total += size
      if (total > limits.extractedBytes) throw new Refused({ reason: `the connector is larger than ${limits.extractedBytes} bytes` })
    }
  }
}

/**
 * Walks a staged tree without following links, refuses links, special files and trees over the
 * limits, and sets modes to 0755 for directories and executables and 0644 for other files. Every
 * source passes this before its files move into the connector directory.
 */
export const inspectTree = async (root: string): Promise<void> => {
  const limit = budget()
  const visit = async (relative: string): Promise<void> => {
    for (const name of await Fs.readdir(Path.join(root, relative))) {
      const path = relative === "" ? name : `${relative}/${name}`
      const absolute = Path.join(root, path)
      const stat = await Fs.lstat(absolute)
      limit.entry()
      if (stat.isSymbolicLink()) throw new Refused({ reason: `${path} is a link, and links are refused` })
      if (stat.isDirectory()) {
        await Fs.chmod(absolute, 0o755)
        await visit(path)
      } else if (stat.isFile()) {
        limit.bytes(stat.size)
        await Fs.chmod(absolute, stat.mode & 0o111 ? 0o755 : 0o644)
      } else throw new Refused({ reason: `${path} is a device or another special file` })
    }
  }
  await visit("")
}

/**
 * Copies a local directory into the stage without following links, leaving out `.git`, and stops
 * at the limits.
 */
export const copyTree = async (source: string, target: string): Promise<void> => {
  const stat = await Fs.lstat(source).catch(() => undefined)
  if (stat === undefined || !stat.isDirectory()) throw new Refused({ reason: `${source} is not a directory` })
  const limit = budget()
  const copy = async (from: string, to: string): Promise<void> => {
    await Fs.mkdir(to, { recursive: true })
    for (const name of await Fs.readdir(from)) {
      if (name === ".git") continue
      const child = Path.join(from, name)
      const entry = await Fs.lstat(child)
      limit.entry()
      if (entry.isSymbolicLink()) throw new Refused({ reason: `${child} is a link, and links are refused` })
      if (entry.isDirectory()) await copy(child, Path.join(to, name))
      else if (entry.isFile()) {
        limit.bytes(entry.size)
        await Fs.copyFile(child, Path.join(to, name), Fs.constants.COPYFILE_EXCL)
      } else throw new Refused({ reason: `${child} is a device or another special file` })
    }
  }
  await copy(source, target)
}

/** The directory that holds `connector.json`: the root, or the one directory at the root. */
export const connectorRoot = async (content: string): Promise<string> => {
  const names = await Fs.readdir(content)
  if (names.includes("connector.json")) return content
  if (names.length === 1) {
    const only = Path.join(content, names[0]!)
    const stat = await Fs.lstat(only)
    if (stat.isDirectory() && (await Fs.readdir(only)).includes("connector.json")) return only
  }
  throw new Refused({ reason: "there is no connector.json at the root" })
}
