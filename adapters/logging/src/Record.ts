import { Cause, LogLevel, Option, References, Schema } from "effect"
import type { Logger } from "effect"

export const levels = ["TRACE", "DEBUG", "INFO", "WARN", "ERROR", "FATAL"] as const
export const Level = Schema.Literals(levels)
export type Level = typeof Level.Type

export const sources = ["daemon", "mcp", "cli"] as const
export const Source = Schema.Literals(sources)
export type Source = typeof Source.Type

/** Annotation keys the daemon uses; other keys are allowed. */
export const keys = [
  "connector",
  "subscription",
  "session",
  "request",
  "method",
  "durationMs",
  "outcome",
  "target",
  "event",
  "error",
  "payload"
] as const

export const LogRecord = Schema.Struct({
  t: Schema.String,
  level: Level,
  src: Source,
  pid: Schema.Number,
  msg: Schema.String,
  ann: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  spans: Schema.optionalKey(Schema.Record(Schema.String, Schema.Number)),
  cause: Schema.optionalKey(Schema.String)
})
export type LogRecord = typeof LogRecord.Type

export const levelOf = (level: LogLevel.LogLevel): Level => {
  switch (level) {
    case "All":
    case "Trace":
      return "TRACE"
    case "Debug":
      return "DEBUG"
    case "Info":
      return "INFO"
    case "Warn":
      return "WARN"
    case "Error":
      return "ERROR"
    case "Fatal":
    case "None":
      return "FATAL"
  }
}

const rank = (level: Level) => levels.indexOf(level)

const part = (value: unknown): string => {
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

const text = (message: unknown) => (Array.isArray(message) ? message : [message]).map(part).join(" ")

/** Builds the record for one log call. An event payload is kept only at DEBUG. */
export const make = (options: Logger.Options<unknown>, src: Source, pid: number): LogRecord => {
  const level = levelOf(options.logLevel)
  const ann: Record<string, unknown> = { ...options.fiber.getRef(References.CurrentLogAnnotations) }
  if (level !== "DEBUG") delete ann.payload
  const now = options.date.getTime()
  const spans: Record<string, number> = {}
  for (const [label, start] of options.fiber.getRef(References.CurrentLogSpans)) spans[label] = now - start
  const cause = options.cause.reasons.length > 0 ? Cause.pretty(options.cause) : ""
  return {
    t: options.date.toISOString(),
    level,
    src,
    pid,
    msg: text(options.message),
    ...(Object.keys(ann).length > 0 ? { ann } : {}),
    ...(Object.keys(spans).length > 0 ? { spans } : {}),
    ...(cause !== "" ? { cause } : {})
  }
}

export const encode = (record: LogRecord): string => JSON.stringify(record)

const decode = Schema.decodeUnknownOption(LogRecord)

/** Reads one line of a log file; anything that is not a record gives none. */
export const parse = (line: string): Option.Option<LogRecord> => {
  try {
    return decode(JSON.parse(line))
  } catch {
    return Option.none()
  }
}

/** One line for people: time, level, source and pid, message, annotations, spans, then the cause indented. */
export const format = (record: LogRecord): string => {
  const ann = Object.entries(record.ann ?? {}).map(([key, value]) => `${key}=${part(value)}`)
  const spans = Object.entries(record.spans ?? {}).map(([label, ms]) => `${label}=${ms}ms`)
  const head = [record.t, record.level.padEnd(5), `${record.src}[${record.pid}]`, record.msg, ...ann, ...spans].join(" ")
  return record.cause === undefined ? head : `${head}\n${record.cause.replace(/^/gm, "  ")}`
}

export interface Filter {
  /** The least severe level shown. */
  readonly level?: Level
  /** Records at or after this time. */
  readonly since?: Date
  readonly connector?: string
  readonly sources?: ReadonlyArray<Source>
}

export const matches = (record: LogRecord, filter: Filter): boolean =>
  (filter.level === undefined || rank(record.level) >= rank(filter.level)) &&
  (filter.since === undefined || Date.parse(record.t) >= filter.since.getTime()) &&
  (filter.connector === undefined || record.ann?.connector === filter.connector) &&
  (filter.sources === undefined || filter.sources.includes(record.src))
