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

interface Chunk {
  readonly lines: Array<string>
  readonly id: string
  readonly offset: number
}

const identity = (info: fs.Stats) => `${info.dev}:${info.ino}:${info.birthtimeMs}`

const readLines = (path: string, from: (id: string, size: number) => number | undefined): Chunk | undefined => {
  let fd: number
  try {
    fd = fs.openSync(path, "r")
  } catch {
    return undefined
  }
  try {
    const info = fs.fstatSync(fd)
    const id = identity(info)
    const offset = from(id, info.size)
    if (offset === undefined) return undefined
    if (info.size <= offset) return { lines: [], id, offset }
    const buffer = Buffer.alloc(info.size - offset)
    const read = fs.readSync(fd, buffer, 0, buffer.length, offset)
    const end = buffer.subarray(0, read).lastIndexOf(0x0a)
    if (end === -1) return { lines: [], id, offset }
    return { lines: buffer.subarray(0, end).toString("utf8").split("\n"), id, offset: offset + end + 1 }
  } finally {
    fs.closeSync(fd)
  }
}

const parsed = (lines: ReadonlyArray<string>): Array<Record.LogRecord> =>
  lines.flatMap((line) => Option.toArray(Record.parse(line)))

interface Cursor {
  readonly src: Record.Source
  readonly offset: number
  readonly order: number
}

export class Tail {
  private cursors = new Map<string, Cursor>()
  private next = 0

  constructor(readonly dir: string, readonly sources: ReadonlyArray<Record.Source>) {}

  backlog(): Array<Record.LogRecord> {
    this.cursors = new Map()
    return this.poll()
  }

  poll(): Array<Record.LogRecord> {
    const records: Array<Record.LogRecord> = []
    const seen = new Set<string>()
    for (const src of this.sources) {
      for (const path of files(this.dir, src)) {
        const read = readLines(path, (id, size) => {
          if (seen.has(id)) return undefined
          const offset = this.cursors.get(id)?.offset ?? 0
          return size < offset ? 0 : offset
        })
        if (read === undefined) continue
        records.push(...parsed(read.lines))
        seen.add(read.id)
        this.cursors.set(read.id, { src, offset: read.offset, order: this.cursors.get(read.id)?.order ?? this.next++ })
      }
    }
    for (const [id, cursor] of this.cursors) {
      if (seen.has(id)) continue
      const newer = [...this.cursors.values()].filter((other) => other.src === cursor.src && other.order > cursor.order)
      if (newer.length > keep) this.cursors.delete(id)
    }
    return merge(records)
  }
}
