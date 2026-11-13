import { createHash } from "node:crypto"
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { basename, join } from "node:path"

export type Os = "darwin" | "linux"
export type Arch = "arm64" | "x64"

export interface Target {
  readonly os: Os
  readonly arch: Arch
  readonly bunTarget: string
  readonly rustTriple: string
}

export const targets: ReadonlyArray<Target> = [
  { os: "darwin", arch: "arm64", bunTarget: "bun-darwin-arm64", rustTriple: "aarch64-apple-darwin" },
  { os: "darwin", arch: "x64", bunTarget: "bun-darwin-x64", rustTriple: "x86_64-apple-darwin" },
  { os: "linux", arch: "x64", bunTarget: "bun-linux-x64", rustTriple: "x86_64-unknown-linux-gnu" },
  { os: "linux", arch: "arm64", bunTarget: "bun-linux-arm64", rustTriple: "aarch64-unknown-linux-gnu" }
]

export const platformOf = (target: Target): string => `${target.os}-${target.arch}`

export const hostTarget = (): Target => {
  const os = process.platform === "darwin" ? "darwin" : process.platform === "linux" ? "linux" : undefined
  const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : undefined
  const found = targets.find((target) => target.os === os && target.arch === arch)
  if (found === undefined) throw new Error(`No build target for ${process.platform}-${process.arch}`)
  return found
}

export const findTarget = (platform: string): Target => {
  const found = targets.find((target) => platformOf(target) === platform)
  if (found === undefined) {
    throw new Error(`Unknown target ${platform}, expected one of ${targets.map(platformOf).join(", ")}`)
  }
  return found
}

export const binaryArchiveName = (version: string, target: Target): string =>
  `exangelos-${version}-${target.os}-${target.arch}.tar.gz`

export const connectorArchiveName = (name: string, version: string): string => `${name}-${version}.tar.gz`

export const checksumFileName = "SHA256SUMS"

export const sha256File = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex")

export interface ChecksumLine {
  readonly sha256: string
  readonly file: string
}

export const formatChecksums = (lines: ReadonlyArray<ChecksumLine>): string =>
  [...lines]
    .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))
    .map((line) => `${line.sha256}  ${line.file}\n`)
    .join("")

export const parseChecksums = (text: string): ReadonlyArray<ChecksumLine> =>
  text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const match = /^([0-9a-f]{64}) [ *](.+)$/.exec(line)
      if (match === null) throw new Error(`Not a ${checksumFileName} line: ${line}`)
      return { sha256: match[1]!, file: match[2]! }
    })

export const writeChecksums = (directory: string, files: ReadonlyArray<string>): string => {
  const path = join(directory, checksumFileName)
  writeFileSync(path, formatChecksums(files.map((file) => ({ sha256: sha256File(file), file: basename(file) }))))
  return path
}

export const clearReleaseFiles = (directory: string): void => {
  if (!existsSync(directory)) return
  for (const name of readdirSync(directory)) {
    if (name.endsWith(".tar.gz") || name === checksumFileName || name === "official-connectors.json" || name === "binaries" || name === "sidecars") {
      rmSync(join(directory, name), { recursive: true, force: true })
    }
  }
}

export const readChecksums = (directory: string): ReadonlyArray<ChecksumLine> =>
  parseChecksums(readFileSync(join(directory, checksumFileName), "utf8"))
