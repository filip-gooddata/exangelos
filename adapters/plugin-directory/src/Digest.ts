import { createHash, type Hash } from "node:crypto"
import { createReadStream } from "node:fs"
import * as Fs from "node:fs/promises"
import * as Path from "node:path"
import { Effect, Schema } from "effect"

export class DigestFailed extends Schema.TaggedError<DigestFailed>()("DigestFailed", {
  directory: Schema.String,
  reason: Schema.String
}) {}

type Record = {
  readonly path: string
  readonly kind: "file" | "link"
  readonly executable: boolean
}

const collect = async (root: string): Promise<Array<Record>> => {
  const records: Array<Record> = []
  const visit = async (relative: string): Promise<void> => {
    const entries = await Fs.readdir(Path.join(root, relative), { withFileTypes: true })
    for (const entry of entries) {
      const path = relative === "" ? entry.name : `${relative}/${entry.name}`
      const stat = await Fs.lstat(Path.join(root, path))
      if (stat.isDirectory()) await visit(path)
      else if (stat.isFile()) records.push({ path, kind: "file", executable: (stat.mode & 0o111) !== 0 })
      else if (stat.isSymbolicLink()) records.push({ path, kind: "link", executable: false })
      else throw new Error(`${path} is neither a file, a directory nor a link`)
    }
  }
  await visit("")
  return records.sort((a, b) => Buffer.compare(Buffer.from(a.path, "utf8"), Buffer.from(b.path, "utf8")))
}

const frame = (hash: Hash, record: Record, length: number) => {
  const path = Buffer.from(record.path, "utf8")
  const header = Buffer.alloc(2 + 4 + path.length + 8)
  header.write(record.kind === "file" ? "f" : "l", 0, "latin1")
  header.write(record.executable ? "x" : "-", 1, "latin1")
  header.writeUInt32BE(path.length, 2)
  path.copy(header, 6)
  header.writeBigUInt64BE(BigInt(length), 6 + path.length)
  hash.update(header)
}

const feed = async (hash: Hash, root: string, record: Record) => {
  const absolute = Path.join(root, record.path)
  if (record.kind === "link") {
    const target = Buffer.from(await Fs.readlink(absolute), "utf8")
    frame(hash, record, target.length)
    hash.update(target)
    return
  }
  const { size } = await Fs.lstat(absolute)
  frame(hash, record, size)
  let read = 0
  for await (const chunk of createReadStream(absolute) as AsyncIterable<Buffer>) {
    read += chunk.length
    hash.update(chunk)
  }
  if (read !== size) throw new Error(`${record.path} changed while it was read`)
}

/**
 * The sha256 of a plugin's files, as bare lowercase hex. Each regular file and link, in bytewise
 * order of its UTF-8 relative path with `/` separators, adds a record: a kind byte (`f` or `l`), an
 * execute byte (`x` when any execute bit is set on a file, else `-`), the path length as u32 big
 * endian, the path, the content length as u64 big endian and the content (a link's target text).
 * Directories, timestamps, owners and other permission bits do not count. Links are not followed.
 */
export const digestDirectory = (directory: string): Effect.Effect<string, DigestFailed> =>
  Effect.tryPromise({
    try: async () => {
      const hash = createHash("sha256")
      for (const record of await collect(directory)) await feed(hash, directory, record)
      return hash.digest("hex")
    },
    catch: (cause) => new DigestFailed({ directory, reason: cause instanceof Error ? cause.message : String(cause) })
  })
