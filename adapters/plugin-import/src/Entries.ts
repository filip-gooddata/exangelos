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

/**
 * Walks a staged tree without following links and refuses links, special files and trees over the
 * limits. Every source passes this before its files move into the plugin directory.
 */
export const inspectTree = async (root: string): Promise<void> => {
  let count = 0
  let total = 0
  const visit = async (relative: string): Promise<void> => {
    for (const name of await Fs.readdir(Path.join(root, relative))) {
      const path = relative === "" ? name : `${relative}/${name}`
      const stat = await Fs.lstat(Path.join(root, path))
      if (++count > limits.entries) throw new Refused({ reason: `the plugin has more than ${limits.entries} files` })
      if (stat.isSymbolicLink()) throw new Refused({ reason: `${path} is a link, and links are refused` })
      if (stat.isDirectory()) await visit(path)
      else if (stat.isFile()) {
        total += stat.size
        if (total > limits.extractedBytes) throw new Refused({ reason: `the plugin is larger than ${limits.extractedBytes} bytes` })
      } else throw new Refused({ reason: `${path} is a device or another special file` })
    }
  }
  await visit("")
}

/**
 * Copies a local directory into the stage without following links, leaving out `.git`.
 */
export const copyTree = async (source: string, target: string): Promise<void> => {
  const stat = await Fs.lstat(source).catch(() => undefined)
  if (stat === undefined || !stat.isDirectory()) throw new Refused({ reason: `${source} is not a directory` })
  await Fs.mkdir(target, { recursive: true })
  for (const name of await Fs.readdir(source)) {
    if (name === ".git") continue
    const from = Path.join(source, name)
    const to = Path.join(target, name)
    const entry = await Fs.lstat(from)
    if (entry.isSymbolicLink()) throw new Refused({ reason: `${name} in ${source} is a link, and links are refused` })
    if (entry.isDirectory()) await copyTree(from, to)
    else if (entry.isFile()) {
      await Fs.copyFile(from, to, Fs.constants.COPYFILE_EXCL)
      await Fs.chmod(to, entry.mode & 0o111 ? 0o755 : 0o644)
    } else throw new Refused({ reason: `${name} in ${source} is a device or another special file` })
  }
}

/** The directory that holds `plugin.json`: the root, or the one directory at the root. */
export const pluginRoot = async (content: string): Promise<string> => {
  const names = await Fs.readdir(content)
  if (names.includes("plugin.json")) return content
  if (names.length === 1) {
    const only = Path.join(content, names[0]!)
    const stat = await Fs.lstat(only)
    if (stat.isDirectory() && (await Fs.readdir(only)).includes("plugin.json")) return only
  }
  throw new Refused({ reason: "there is no plugin.json at the root" })
}
