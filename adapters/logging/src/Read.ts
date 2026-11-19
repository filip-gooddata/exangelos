import * as fs from "node:fs"
import * as Path from "node:path"
import { Option } from "effect"
import { fileName, keep } from "./FileLog.ts"
import * as Record from "./Record.ts"

const units: { readonly [unit: string]: number } = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }

/** A span such as 90s, 10m, 2h, 1d or 1w, in milliseconds. */
export const duration = (text: string): Option.Option<number> => {
  const match = /^(\d+)\s*([smhdw])$/.exec(text.trim())
  return match === null ? Option.none() : Option.some(Number(match[1]) * units[match[2]!]!)
}

/** `--since`: a span back from `now`, or an ISO 8601 time. */
export const since = (text: string, now: Date): Option.Option<Date> =>
  Option.match(duration(text), {
    onSome: (ms) => Option.some(new Date(now.getTime() - ms)),
    onNone: () => {
      if (!/^\d{4}-\d{2}-\d{2}/.test(text.trim())) return Option.none()
      const at = Date.parse(text.trim())
      return Number.isNaN(at) ? Option.none() : Option.some(new Date(at))
    }
  })

/** Orders records by time; records with the same time keep their order. */
export const merge = (records: ReadonlyArray<Record.LogRecord>): Array<Record.LogRecord> =>
  records
    .map((record, index) => ({ record, index, at: Date.parse(record.t) }))
    .sort((a, b) => a.at - b.at || a.index - b.index)
    .map(({ record }) => record)

/** The files of one source, oldest first: the rotations from `.5` down to `.1`, then the current file. */
export const files = (dir: string, src: Record.Source): Array<string> => [
  ...Array.from({ length: keep }, (_, i) => Path.join(dir, fileName(src, keep - i))),
  Path.join(dir, fileName(src))
]

interface Position {
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

/** The complete lines of `path` from `offset`, and the offset after the last of them. */
const linesFrom = (path: string, offset: number): { readonly lines: Array<string>; readonly offset: number } => {
  let fd: number
  try {
    fd = fs.openSync(path, "r")
  } catch {
    return { lines: [], offset }
  }
  try {
    const size = fs.fstatSync(fd).size
    if (size <= offset) return { lines: [], offset }
    const buffer = Buffer.alloc(size - offset)
    const read = fs.readSync(fd, buffer, 0, buffer.length, offset)
    const end = buffer.subarray(0, read).lastIndexOf(0x0a)
    if (end === -1) return { lines: [], offset }
    return { lines: buffer.subarray(0, end).toString("utf8").split("\n"), offset: offset + end + 1 }
  } finally {
    fs.closeSync(fd)
  }
}

const parsed = (lines: ReadonlyArray<string>): Array<Record.LogRecord> =>
  lines.flatMap((line) => Option.toArray(Record.parse(line)))

/**
 * Reads the log files of some sources: first everything written so far, then, on each poll, the lines appended
 * since. It follows a file through rotation by its inode, and picks up files that appear later.
 */
export class Tail {
  private readonly positions = new Map<Record.Source, Position>()

  constructor(readonly dir: string, readonly sources: ReadonlyArray<Record.Source>) {}

  /** Every record in the rotations and current files, merged by time. Unparseable lines are skipped. */
  backlog(): Array<Record.LogRecord> {
    const records: Array<Record.LogRecord> = []
    for (const src of this.sources) {
      const paths = files(this.dir, src)
      const current = paths.pop()!
      for (const path of paths) records.push(...parsed(linesFrom(path, 0).lines))
      const info = stat(current)
      if (info === undefined) continue
      const read = linesFrom(current, 0)
      records.push(...parsed(read.lines))
      this.positions.set(src, { ino: info.ino, offset: read.offset })
    }
    return merge(records)
  }

  /** The records appended since the last call, merged by time. */
  poll(): Array<Record.LogRecord> {
    const records: Array<Record.LogRecord> = []
    for (const src of this.sources) {
      const current = Path.join(this.dir, fileName(src))
      const known = this.positions.get(src)
      const info = stat(current)
      if (known !== undefined && (info === undefined || info.ino !== known.ino)) {
        const rotated = files(this.dir, src).slice(0, -1).find((path) => stat(path)?.ino === known.ino)
        if (rotated !== undefined) records.push(...parsed(linesFrom(rotated, known.offset).lines))
        this.positions.delete(src)
      }
      if (info === undefined) continue
      const from = this.positions.get(src)
      const offset = from === undefined || info.size < from.offset ? 0 : from.offset
      const read = linesFrom(current, offset)
      records.push(...parsed(read.lines))
      this.positions.set(src, { ino: info.ino, offset: read.offset })
    }
    return merge(records)
  }
}
