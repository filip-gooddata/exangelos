import { createWriteStream } from "node:fs"
import * as Fs from "node:fs/promises"
import * as Path from "node:path"
import { pipeline } from "node:stream/promises"
import * as Tar from "tar"
import * as Yauzl from "yauzl"
import { type Entry, type Kind, preflight, Refused } from "./Entries.ts"

const tarKind = (type: string): Kind => {
  switch (type) {
    case "File":
    case "OldFile":
    case "ContiguousFile":
      return "file"
    case "Directory":
      return "directory"
    case "SymbolicLink":
    case "Link":
      return "link"
    default:
      return "special"
  }
}

const unpackTarGz = async (file: string, target: string) => {
  const entries: Array<Entry> = []
  await Tar.t({
    file,
    strict: true,
    onReadEntry: (entry) => {
      entries.push({ path: entry.path, kind: tarKind(entry.type), size: entry.size ?? 0 })
    }
  })
  preflight(entries)
  await Tar.x({
    file,
    cwd: target,
    strict: true,
    preserveOwner: false,
    filter: (_path, entry) => "type" in entry && (tarKind(entry.type) === "file" || tarKind(entry.type) === "directory")
  })
}

const zipOptions = {
  lazyEntries: true,
  decodeStrings: true,
  strictFileNames: true,
  validateEntrySizes: true,
  autoClose: true
} as Yauzl.Options

const openZip = (file: string) =>
  new Promise<Yauzl.ZipFile>((resolve, reject) =>
    Yauzl.open(file, zipOptions, (error, zip) => (error ? reject(error) : resolve(zip)))
  )

const zipKind = (entry: Yauzl.Entry): Kind => {
  const type = (entry.externalFileAttributes >>> 16) & 0o170000
  if (entry.fileName.endsWith("/")) return type === 0 || type === 0o040000 ? "directory" : "special"
  if (type === 0 || type === 0o100000) return "file"
  if (type === 0o040000) return "directory"
  if (type === 0o120000) return "link"
  return "special"
}

const eachZipEntry = async (file: string, visit: (zip: Yauzl.ZipFile, entry: Yauzl.Entry) => Promise<void>) => {
  const zip = await openZip(file)
  await new Promise<void>((resolve, reject) => {
    zip.on("error", reject)
    zip.on("end", () => resolve())
    zip.on("entry", (entry: Yauzl.Entry) => {
      visit(zip, entry).then(() => zip.readEntry(), (error) => {
        zip.close()
        reject(error)
      })
    })
    zip.readEntry()
  })
}

const unpackZip = async (file: string, target: string) => {
  const entries: Array<Yauzl.Entry> = []
  await eachZipEntry(file, async (_zip, entry) => {
    entries.push(entry)
  }).catch((error: unknown) => {
    if (error instanceof Refused) throw error
    throw new Refused({ reason: `the zip archive is refused: ${error instanceof Error ? error.message : String(error)}` })
  })
  const checked = preflight(entries.map((entry) => ({ path: entry.fileName, kind: zipKind(entry), size: entry.uncompressedSize })))
  const wanted = new Map(checked.map((entry, index) => [entries[index]!.fileName, entry]))

  await eachZipEntry(file, async (zip, raw) => {
    const entry = wanted.get(raw.fileName)
    if (entry === undefined) throw new Refused({ reason: `the zip archive changed while it was read` })
    const path = Path.join(target, entry.path)
    if (entry.kind === "directory") {
      await Fs.mkdir(path, { recursive: true })
      return
    }
    await Fs.mkdir(Path.dirname(path), { recursive: true })
    const executable = ((raw.externalFileAttributes >>> 16) & 0o111) !== 0
    const stream = await new Promise<NodeJS.ReadableStream>((resolve, reject) =>
      zip.openReadStream(raw, (error, readable) => (error ? reject(error) : resolve(readable)))
    )
    await pipeline(stream, createWriteStream(path, { flags: "wx", mode: executable ? 0o755 : 0o644 }))
  })
}

/** Unpacks a zip or tar.gz archive into the empty target after every entry passes the preflight. */
export const unpack = async (file: string, target: string): Promise<void> => {
  const handle = await Fs.open(file, "r")
  const head = Buffer.alloc(4)
  try {
    await handle.read(head, 0, 4, 0)
  } finally {
    await handle.close()
  }
  await Fs.mkdir(target, { recursive: true })
  if (head[0] === 0x1f && head[1] === 0x8b) return unpackTarGz(file, target)
  if (head[0] === 0x50 && head[1] === 0x4b) return unpackZip(file, target)
  throw new Refused({ reason: "the file is not a zip or tar.gz archive" })
}
