import { createHash } from "node:crypto"
import { lstatSync, readFileSync, readdirSync, readlinkSync } from "node:fs"
import { join } from "node:path"

// Stand-in for `digestDirectory` from `@exangelos/plugin-directory`, written to the
// definition agreed with the plugin-files stream. Replace it with that import once
// the adapter lands, so the build and the daemon share one implementation.
export const digestDirectory = (directory: string): string => {
  const records: Array<{ readonly path: Buffer; readonly kind: "f" | "l"; readonly mode: "x" | "-"; readonly content: Buffer }> = []
  const walk = (relative: string): void => {
    for (const name of readdirSync(join(directory, relative))) {
      const path = relative === "" ? name : `${relative}/${name}`
      const absolute = join(directory, path)
      const stat = lstatSync(absolute)
      if (stat.isDirectory()) walk(path)
      else if (stat.isSymbolicLink()) {
        records.push({ path: Buffer.from(path, "utf8"), kind: "l", mode: "-", content: Buffer.from(readlinkSync(absolute), "utf8") })
      } else if (stat.isFile()) {
        records.push({ path: Buffer.from(path, "utf8"), kind: "f", mode: (stat.mode & 0o111) !== 0 ? "x" : "-", content: readFileSync(absolute) })
      } else throw new Error(`Cannot digest ${absolute}: not a file, link or directory`)
    }
  }
  walk("")
  records.sort((a, b) => Buffer.compare(a.path, b.path))
  const hash = createHash("sha256")
  for (const record of records) {
    const pathLength = Buffer.alloc(4)
    pathLength.writeUInt32BE(record.path.length)
    const contentLength = Buffer.alloc(8)
    contentLength.writeBigUInt64BE(BigInt(record.content.length))
    hash.update(record.kind).update(record.mode).update(pathLength).update(record.path).update(contentLength).update(record.content)
  }
  return hash.digest("hex")
}
