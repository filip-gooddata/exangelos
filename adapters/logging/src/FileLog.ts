import * as fs from "node:fs"
import { Paths } from "@exangelos/paths"
import { Effect, Layer, Logger, LogLevel, References } from "effect"
import * as Level from "./Level.ts"
import * as Record from "./Record.ts"
import { redactRecord, redactText, redactValue, Secrets } from "./Redact.ts"

export const maxBytes = 5 * 1024 * 1024
export const keep = 5

export const fileName = (src: Record.Source, generation?: number) =>
  generation === undefined ? `${src}.jsonl` : `${src}.${generation}.jsonl`

export interface Sink {
  readonly file: string
  readonly write: (line: string) => void
}

/**
 * Appends whole lines to `<dir>/<src>.jsonl`, reopening the path on every write so processes
 * sharing the file and rotating it tolerate each other. A file that reached `maxBytes` becomes
 * `<src>.1.jsonl` and older ones move up, keeping `keep`. A failed write drops the line and is
 * reported once.
 */
export const sink = (options: {
  readonly dir: string
  readonly src: Record.Source
  readonly maxBytes?: number
  readonly keep?: number
  readonly report?: (message: string) => void
}): Sink => {
  const limit = options.maxBytes ?? maxBytes
  const count = options.keep ?? keep
  const file = `${options.dir}/${fileName(options.src)}`
  const generation = (n: number) => `${options.dir}/${fileName(options.src, n)}`
  const report = options.report ?? ((message: string) => console.error(message))
  let ready = false
  let reported = false

  const prepare = () => {
    fs.mkdirSync(options.dir, { recursive: true, mode: 0o700 })
    try {
      fs.chmodSync(options.dir, 0o700)
    } catch {
      // A directory someone else owns keeps its mode; writing may still work.
    }
    ready = true
  }

  const rotate = () => {
    let size: number
    try {
      size = fs.statSync(file).size
    } catch {
      return
    }
    if (size < limit) return
    for (let n = count - 1; n >= 1; n--) {
      try {
        fs.renameSync(generation(n), generation(n + 1))
      } catch {
        // A missing generation, or another process rotating at the same time.
      }
    }
    try {
      fs.renameSync(file, generation(1))
    } catch {
      // Another process rotated it first.
    }
  }

  const write = (line: string) => {
    try {
      if (!ready) prepare()
      rotate()
      fs.appendFileSync(file, `${line}\n`, { mode: 0o600 })
    } catch (error) {
      if (reported) return
      reported = true
      report(`exangelos: cannot write the log ${file}, so log records are dropped: ${String(error)}`)
    }
  }

  return { file, write }
}

/** The redacted record for one log call. */
export const record = (options: Logger.Options<unknown>, src: Record.Source): Record.LogRecord => {
  const secrets = Secrets.values()
  return redactRecord(Record.make({ ...options, message: redactValue(options.message, secrets) }, src, process.pid), secrets)
}

/** Stands in for a record that could not be built or encoded, such as one whose annotation getter throws. */
const unbuilt = (options: Logger.Options<unknown>, src: Record.Source, error: unknown): Record.LogRecord => ({
  t: options.date.toISOString(),
  level: Record.levelOf(options.logLevel),
  src,
  pid: process.pid,
  msg: redactText(`a log record could not be written: ${String(error)}`, Secrets.values())
})

const encoded = (options: Logger.Options<unknown>, src: Record.Source) => {
  try {
    return Record.encode(record(options, src))
  } catch (error) {
    return Record.encode(unbuilt(options, src, error))
  }
}

/** Writes records at or above the live level (Level.current) to the sink. */
export const fileLogger = (src: Record.Source, target: Sink) =>
  Logger.make<unknown, void>((options) => {
    if (Level.enabled(options.logLevel)) target.write(encoded(options, src))
  })

/** Writes records at or above `minimum` to stderr in the human form, redacted. */
export const stderrLogger = (src: Record.Source, minimum: LogLevel.LogLevel) =>
  Logger.make<unknown, void>((options) => {
    if (!LogLevel.isGreaterThanOrEqualTo(options.logLevel, minimum)) return
    try {
      console.error(Record.format(record(options, src)))
    } catch (error) {
      console.error(Record.format(unbuilt(options, src, error)))
    }
  })

/** Passes only records at or above `minimum` to `logger`. */
export const atLeast = <Message, Output>(minimum: LogLevel.LogLevel, logger: Logger.Logger<Message, Output>) =>
  Logger.make<Message, Output | undefined>((options) =>
    LogLevel.isGreaterThanOrEqualTo(options.logLevel, minimum) ? logger.log(options) : undefined
  )

const settingOf = (settingsFile: string): Level.Name | undefined => {
  try {
    const level: unknown = JSON.parse(fs.readFileSync(settingsFile, "utf8"))?.logLevel
    return typeof level === "string" && (Level.names as ReadonlyArray<string>).includes(level)
      ? level as Level.Name
      : undefined
  } catch {
    return undefined
  }
}

/**
 * The loggers for one process: its log file in Paths.logDir at the live level, and `console`.
 * Reads the logLevel setting and EXANGELOS_LOG_LEVEL once.
 */
export const layer = (options: {
  readonly src: Record.Source
  readonly console: Logger.Logger<unknown, unknown>
}) =>
  Layer.unwrap(
    Effect.gen(function*() {
      const paths = yield* Paths.Paths
      yield* Level.init(settingOf(paths.settingsFile))
      return Layer.mergeAll(
        Logger.layer([fileLogger(options.src, sink({ dir: paths.logDir, src: options.src })), options.console]),
        Layer.succeed(References.MinimumLogLevel, "Trace")
      )
    })
  )
