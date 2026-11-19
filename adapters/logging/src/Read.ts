import * as fs from "node:fs"
import * as Path from "node:path"
import { Option } from "effect"
import { fileName, keep } from "./FileLog.ts"
import * as Record from "./Record.ts"

const units: { readonly [unit: string]: number } = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }

export const duration = (text: string): Option.Option<number> => {
  const match = /^(\d+)\s*([smhdw])$/.exec(text.trim())
  return match === null ? Option.none() : Option.some(Number(match[1]) * units[match[2]!]!)
}

export const since = (text: string, now: Date): Option.Option<Date> =>
  Option.match(duration(text), {
    onSome: (ms) => Option.some(new Date(now.getTime() - ms)),
    onNone: () => {
      if (!/^\d{4}-\d{2}-\d{2}/.test(text.trim())) return Option.none()
      const at = Date.parse(text.trim())
      return Number.isNaN(at) ? Option.none() : Option.some(new Date(at))
    }
  })

export const merge = (records: ReadonlyArray<Record.LogRecord>): Array<Record.LogRecord> =>
  records
    .map((record, index) => ({ record, index, at: Date.parse(record.t) }))
    .sort((a, b) => a.at - b.at || a.index - b.index)
    .map(({ record }) => record)

export const files = (dir: string, src: Record.Source): Array<string> => [
  ...Array.from({ length: keep }, (_, i) => Path.join(dir, fileName(src, keep - i))),
  Path.join(dir, fileName(src))
]

interface Position {
  readonly ino: number
  readonly offset: number
}

interface Chunk {
  readonly lines: Array<string>
  readonly ino: number
  readonly offset: number
}

const stat = (path: string): fs.Stats | undefined => {
  try {
    return fs.statSync(path)
  } catch {
    return undefined
  }
}

const readLines = (path: string, from: (info: fs.Stats) => number | undefined): Chunk | undefined => {
  let fd: number
  try {
    fd = fs.openSync(path, "r")
  } catch {
    return undefined
  }
  try {
    const info = fs.fstatSync(fd)
    const offset = from(info)
    if (offset === undefined) return undefined
    if (info.size <= offset) return { lines: [], ino: info.ino, offset }
    const buffer = Buffer.alloc(info.size - offset)
    const read = fs.readSync(fd, buffer, 0, buffer.length, offset)
    const end = buffer.subarray(0, read).lastIndexOf(0x0a)
    if (end === -1) return { lines: [], ino: info.ino, offset }
    return {
      lines: buffer.subarray(0, end).toString("utf8").split("\n"),
      ino: info.ino,
      offset: offset + end + 1
    }
  } finally {
    fs.closeSync(fd)
  }
}

const parsed = (lines: ReadonlyArray<string>): Array<Record.LogRecord> =>
  lines.flatMap((line) => Option.toArray(Record.parse(line)))

export class Tail {
  private readonly positions = new Map<Record.Source, Position>()

  constructor(readonly dir: string, readonly sources: ReadonlyArray<Record.Source>) {}

  backlog(): Array<Record.LogRecord> {
    const records: Array<Record.LogRecord> = []
    for (const src of this.sources) {
      const paths = files(this.dir, src)
      const current = paths.pop()!
      for (const path of paths) records.push(...parsed(readLines(path, () => 0)?.lines ?? []))
      const read = readLines(current, () => 0)
      if (read === undefined) continue
      records.push(...parsed(read.lines))
      this.positions.set(src, { ino: read.ino, offset: read.offset })
    }
    return merge(records)
  }

  poll(): Array<Record.LogRecord> {
    const records: Array<Record.LogRecord> = []
    for (const src of this.sources) {
      const paths = files(this.dir, src)
      const current = paths.pop()!
      const known = this.positions.get(src)
      let rotated = false
      const read = readLines(current, (info) => {
        if (known === undefined) return 0
        if (info.ino !== known.ino) {
          rotated = true
          return 0
        }
        return info.size < known.offset ? 0 : known.offset
      })
      if (known !== undefined && (read === undefined || rotated)) {
        const at = paths.findIndex((path) => stat(path)?.ino === known.ino)
        if (at !== -1) {
          records.push(...parsed(readLines(paths[at]!, (info) => (info.ino === known.ino ? known.offset : 0))?.lines ?? []))
        }
        for (const path of paths.slice(at + 1)) records.push(...parsed(readLines(path, () => 0)?.lines ?? []))
        this.positions.delete(src)
      }
      if (read === undefined) continue
      records.push(...parsed(read.lines))
      this.positions.set(src, { ino: read.ino, offset: read.offset })
    }
    return merge(records)
  }
}
