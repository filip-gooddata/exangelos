import { accessSync, constants, readdirSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { delimiter, dirname, isAbsolute, join } from "node:path"
import type { Invocation, Outcome } from "./Attempt.ts"

/**
 * Finds a harness CLI by name for a daemon that may run without the owner's shell PATH: a
 * Homebrew service, a launchd agent or a systemd unit only sees a system PATH, while `t3`, `codex`
 * and the like usually sit in user directories such as ~/.local/bin or a Node version manager's.
 */
export interface Lookup {
  /** The daemon's own PATH, searched first. */
  readonly path: string | undefined
  readonly home: string | undefined
  readonly platform: string
  readonly isExecutable: (file: string) => boolean
  /** The entries of a directory, or none when it can't be read. */
  readonly listDirectory: (directory: string) => ReadonlyArray<string>
}

export type Resolved =
  | { readonly _tag: "Found"; readonly file: string }
  | { readonly _tag: "NotFound"; readonly searched: ReadonlyArray<string> }

const versionParts = (name: string): ReadonlyArray<number> => name.replace(/^v/, "").split(".").map((part) => Number.parseInt(part, 10) || 0)

const newestFirst = (a: string, b: string): number => {
  const left = versionParts(a)
  const right = versionParts(b)
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (right[index] ?? 0) - (left[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

/** Where user installs of harness CLIs usually land, after the daemon's PATH. */
const userDirectories = (home: string, lookup: Lookup): ReadonlyArray<string> => {
  const nvm = join(home, ".nvm", "versions", "node")
  return [
    join(home, ".local", "bin"),
    join(home, "bin"),
    join(home, ".bun", "bin"),
    join(home, ".volta", "bin"),
    join(home, ".npm-global", "bin"),
    join(home, "Library", "pnpm"),
    join(home, ".local", "share", "pnpm"),
    join(home, ".local", "share", "fnm", "aliases", "default", "bin"),
    join(home, "Library", "Application Support", "fnm", "aliases", "default", "bin"),
    join(home, ".fnm", "aliases", "default", "bin"),
    ...[...lookup.listDirectory(nvm)].sort(newestFirst).map((version) => join(nvm, version, "bin")),
    join(home, ".local", "share", "mise", "shims"),
    join(home, ".asdf", "shims"),
    join(home, ".cargo", "bin")
  ]
}

const systemDirectories = (platform: string): ReadonlyArray<string> => [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  ...(platform === "linux" ? ["/home/linuxbrew/.linuxbrew/bin"] : []),
  "/usr/bin",
  "/bin"
]

const servicePath = (lookup: Lookup): ReadonlyArray<string> => (lookup.path ?? "").split(delimiter).filter((entry) => isAbsolute(entry))

/** The directories searched after the daemon's PATH. A home that isn't absolute adds none of its own. */
const fallbackPath = (lookup: Lookup): ReadonlyArray<string> => [
  ...(lookup.home !== undefined && isAbsolute(lookup.home) ? userDirectories(lookup.home, lookup) : []),
  ...systemDirectories(lookup.platform)
]

/** The directories a lookup searches, in order, without repeats. */
export const searchPath = (lookup: Lookup): ReadonlyArray<string> => [...new Set([...servicePath(lookup), ...fallbackPath(lookup)])]

/** A program with a slash in it is a path and is taken as given. */
export const resolve = (program: string, lookup: Lookup): Resolved => {
  if (program.includes("/")) return { _tag: "Found", file: program }
  const searched = searchPath(lookup)
  const file = searched.map((directory) => join(directory, program)).find(lookup.isExecutable)
  return file === undefined ? { _tag: "NotFound", searched } : { _tag: "Found", file }
}

const shortened = (directory: string, home: string | undefined): string =>
  home !== undefined && isAbsolute(home) && (directory === home || directory.startsWith(`${home}/`)) ? `~${directory.slice(home.length)}` : directory

export const notFoundReason = (program: string, searched: ReadonlyArray<string>, home: string | undefined): string =>
  `no executable named ${program} in ${searched.map((directory) => shortened(directory, home)).join(", ")}; ` +
  `link it into one of them, such as ~/.local/bin`

const joined = (directories: ReadonlyArray<string>): string => [...new Set(directories)].join(delimiter)

/**
 * The invocation as it runs: a program found by name runs by its full path, so the spawner can't
 * pick another file. Found on the daemon's PATH, it keeps that PATH. Found in a fallback directory,
 * that directory goes first on the tool's PATH, so a script that starts with `#!/usr/bin/env node`
 * finds the node installed beside it, then the daemon's PATH and the other fallbacks. A program
 * given as an absolute path keeps the daemon's PATH first and gets its own directory and the
 * fallbacks after it; a relative one runs as given. A program found nowhere is an outcome naming
 * every directory searched.
 */
export const locate = (invocation: Invocation, lookup: Lookup): Invocation | Extract<Outcome, { _tag: "NotStarted" }> => {
  const program = invocation.program
  if (program.includes("/")) {
    if (!isAbsolute(program)) return invocation
    const path = joined([...servicePath(lookup), dirname(program), ...fallbackPath(lookup)])
    return { ...invocation, env: { ...invocation.env, PATH: path } }
  }
  const resolved = resolve(program, lookup)
  if (resolved._tag === "NotFound") return { _tag: "NotStarted", reason: notFoundReason(program, resolved.searched, lookup.home) }
  const directory = dirname(resolved.file)
  if (servicePath(lookup).includes(directory)) return { ...invocation, program: resolved.file }
  const path = joined([directory, ...servicePath(lookup), ...fallbackPath(lookup)])
  return { ...invocation, program: resolved.file, env: { ...invocation.env, PATH: path } }
}

const isExecutableFile = (file: string): boolean => {
  try {
    accessSync(file, constants.X_OK)
    return statSync(file).isFile()
  } catch {
    return false
  }
}

const listDirectory = (directory: string): ReadonlyArray<string> => {
  try {
    return readdirSync(directory)
  } catch {
    return []
  }
}

/** The lookup the daemon uses: its own environment and file system, read at each wake. */
export const system = (): Lookup => ({
  path: process.env["PATH"],
  home: process.env["HOME"] || homedir(),
  platform: process.platform,
  isExecutable: isExecutableFile,
  listDirectory
})
