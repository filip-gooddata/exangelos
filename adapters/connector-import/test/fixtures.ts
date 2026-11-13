import { crc32, gzipSync } from "node:zlib"

export interface ArchiveEntry {
  readonly path: string
  readonly content?: string
  readonly type?: "file" | "directory" | "symlink"
  readonly linkTarget?: string
  readonly mode?: number
}

export const manifest = (name: string) =>
  JSON.stringify({ name, version: "1.0.0", entry: { _tag: "Bundle", path: "main.js" } })

export const connectorEntries = (name: string, prefix = ""): Array<ArchiveEntry> => [
  { path: `${prefix}connector.json`, content: manifest(name) },
  { path: `${prefix}main.js`, content: "console.log('hello')" }
]

const octal = (value: number, width: number) => value.toString(8).padStart(width - 1, "0") + "\0"

const tarHeader = (entry: ArchiveEntry, size: number) => {
  const header = Buffer.alloc(512)
  header.write(entry.path, 0, 100, "utf8")
  header.write(octal(entry.mode ?? (entry.type === "directory" ? 0o755 : 0o644), 8), 100, "latin1")
  header.write(octal(0, 8), 108, "latin1")
  header.write(octal(0, 8), 116, "latin1")
  header.write(octal(size, 12), 124, "latin1")
  header.write(octal(0, 12), 136, "latin1")
  header.write("        ", 148, "latin1")
  header.write(entry.type === "directory" ? "5" : entry.type === "symlink" ? "2" : "0", 156, "latin1")
  header.write(entry.linkTarget ?? "", 157, 100, "utf8")
  header.write("ustar\0", 257, "latin1")
  header.write("00", 263, "latin1")
  let sum = 0
  for (const byte of header) sum += byte
  header.write(octal(sum, 7) + " ", 148, "latin1")
  return header
}

/** A gzip tar with exactly these headers, so a test can build archives no honest tool writes. */
export const tarGz = (entries: ReadonlyArray<ArchiveEntry>): Buffer => {
  const blocks = entries.flatMap((entry) => {
    const body = Buffer.from(entry.type === undefined || entry.type === "file" ? entry.content ?? "" : "")
    const padding = Buffer.alloc((512 - (body.length % 512)) % 512)
    return [tarHeader(entry, body.length), body, padding]
  })
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]))
}

/** A zip of stored (uncompressed) files. */
export const zip = (entries: ReadonlyArray<ArchiveEntry>): Buffer => {
  const locals: Array<Buffer> = []
  const centrals: Array<Buffer> = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.path, "utf8")
    const body = Buffer.from(entry.content ?? "")
    const crc = crc32(body)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(body.length, 22)
    local.writeUInt16LE(name.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(0x0314, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(body.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(((0o100000 | (entry.mode ?? 0o644)) << 16) >>> 0, 38)
    central.writeUInt32LE(offset, 42)
    locals.push(local, name, body)
    centrals.push(central, name)
    offset += local.length + name.length + body.length
  }
  const directory = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}
