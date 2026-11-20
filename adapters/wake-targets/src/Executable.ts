import { accessSync, constants, readdirSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { delimiter, dirname, join } from "node:path"
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

const systemDirectories = ["/opt/homebrew/bin", "/usr/local/bin", "/home/linuxbrew/.linuxbrew/bin", "/usr/bin", "/bin"]

/** The directories a lookup searches, in order, without repeats. */
export const searchPath = (lookup: Lookup): ReadonlyArray<string> => {
  const fromPath = (lookup.path ?? "").split(delimiter).filter((entry) => entry.startsWith("/"))
  const fromHome = lookup.home === undefined || lookup.home === "" ? [] : userDirectories(lookup.home, lookup)
  return [...new Set([...fromPath, ...fromHome, ...systemDirectories])]
}

/** A program with a slash in it is a path and is taken as given. */
export const resolve = (program: string, lookup: Lookup): Resolved => {
  if (program.includes("/")) return { _tag: "Found", file: program }
  const searched = searchPath(lookup)
  const file = searched.map((directory) => join(directory, program)).find(lookup.isExecutable)
  return file === undefined ? { _tag: "NotFound", searched } : { _tag: "Found", file }
}

export const notFoundReason = (program: string, searched: ReadonlyArray<string>): string =>
  `no executable named ${program} in ${searched.join(", ")}`

/**
 * The invocation with its program replaced by the file found, and that file's directory put first
 * on the tool's PATH, so a script that starts with `#!/usr/bin/env node` finds the node installed
 * beside it. A program that isn't found is an outcome naming the directories searched.
 */
export const locate = (invocation: Invocation, lookup: Lookup): Invocation | Extract<Outcome, { _tag: "NotStarted" }> => {
  const resolved = resolve(invocation.program, lookup)
  if (resolved._tag === "NotFound") return { _tag: "NotStarted", reason: notFoundReason(invocation.program, resolved.searched) }
  if (resolved.file === invocation.program) return invocation
  const directory = dirname(resolved.file)
  const path = [directory, ...(lookup.path ?? "").split(delimiter).filter((entry) => entry !== "" && entry !== directory)].join(delimiter)
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
  isExecutable: isExecutableFile,
  listDirectory
})
