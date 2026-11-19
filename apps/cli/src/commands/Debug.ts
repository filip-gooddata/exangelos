import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as Path from "node:path"
import { Cause, Console, Effect, Option, Schema } from "effect"
import { Command, Flag } from "effect/cli"
import { SessionHeaders } from "@exangelos/contracts"
import { DaemonClient } from "@exangelos/daemon-client"
import { Connector } from "@exangelos/domain"
import { Level, Read, Record, Redact } from "@exangelos/logging"
import { Paths } from "@exangelos/paths"
import { InstallMethod } from "@exangelos/service"
import * as Build from "../Build.ts"
import { CommandFailed, Json } from "./Output.ts"

const daemonLogTail = 1024 * 1024

const bearer = /\b(Bearer|Basic)\s+[\w.~+/=-]+/gi
const assignment = /\b([\w.-]*(?:token|key|secret|password|auth|cookie)[\w.-]*)(["']?\s*[:=]\s*["']?)([^\s"',;}&]+)/gi

/** Hides values that free text pairs with a sensitive name, such as `apiToken=…` or `Authorization: Bearer …`. */
export const scrub = (text: string): string =>
  text
    .replace(bearer, (_, scheme: string) => `${scheme} ${Redact.redacted}`)
    .replace(assignment, (_, key: string, separator: string) => `${key}${separator}${Redact.redacted}`)

const scrubValue = (value: unknown): unknown => {
  if (typeof value === "string") return scrub(value)
  if (Array.isArray(value)) return value.map(scrubValue)
  if (value === null || typeof value !== "object") return value
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, scrubValue(item)]))
}

/** Drops every value of an `env` map, keeping the names, then applies the key rule and the text rule. */
const cleanValue = (value: unknown): unknown => {
  const withoutEnv = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(withoutEnv)
    if (item === null || typeof item !== "object") return item
    return Object.fromEntries(
      Object.entries(item).map(([key, inner]) => [
        key,
        key === "env" && inner !== null && typeof inner === "object" && !Array.isArray(inner)
          ? Object.fromEntries(Object.keys(inner).map((name) => [name, Redact.redacted]))
          : withoutEnv(inner)
      ])
    )
  }
  return scrubValue(Redact.redactValue(withoutEnv(value), []))
}

const cleanRecord = (record: Record.LogRecord, includePayloads: boolean): Record.LogRecord => {
  const redacted = Redact.redactRecord(record, [])
  const { payload: _, ...rest } = redacted.ann ?? {}
  const ann = includePayloads ? redacted.ann : redacted.ann === undefined ? undefined : rest
  return {
    t: redacted.t,
    level: redacted.level,
    src: redacted.src,
    pid: redacted.pid,
    msg: scrub(redacted.msg),
    ...(ann !== undefined && Object.keys(ann).length > 0 ? { ann: scrubValue(ann) as { [key: string]: unknown } } : {}),
    ...(redacted.spans !== undefined ? { spans: redacted.spans } : {}),
    ...(redacted.cause !== undefined ? { cause: scrub(redacted.cause) } : {})
  }
}

const readJson = (path: string): unknown => {
  try {
    return cleanValue(JSON.parse(fs.readFileSync(path, "utf8")))
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return code === "ENOENT" ? "absent" : `unreadable: ${scrub(String((error as Error).message))}`
  }
}

const digest = (path: string): string => {
  try {
    return `sha256:${createHash("sha256").update(fs.readFileSync(path)).digest("hex")}`
  } catch (error) {
    return `unreadable: ${(error as Error).message}`
  }
}

const encodeConnector = Schema.encodeSync(Schema.toCodecJson(Connector.Connector))

const daemonState = (socketPath: string) =>
  Effect.gen(function*() {
    const client = yield* DaemonClient.DaemonClient
    const service = yield* client.ServiceStatus()
    const connectors = yield* client.ListConnectors()
    return {
      running: true as const,
      service,
      connectors: connectors.map((connector) => {
        const { catalogue: _, configuredBy: __, ...shown } = encodeConnector(connector) as { [key: string]: unknown }
        return cleanValue(shown)
      })
    }
  }).pipe(
    Effect.provide(DaemonClient.layer({ path: socketPath, session: Option.none() })),
    Effect.timeout("5 seconds"),
    Effect.catchCause((cause) => {
      const error = Cause.squash(cause)
      const reason = error instanceof DaemonClient.DaemonNotRunning
        ? error.reason
        : error instanceof Error
        ? error.message
        : String(error)
      return Effect.succeed({ running: false as const, reason: scrub(reason) })
    })
  )

const installed = (connectorDir: string): Array<string> | string => {
  try {
    return fs.readdirSync(connectorDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) =>
      entry.name
    ).sort()
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? [] : `unreadable: ${(error as Error).message}`
  }
}

const tailOf = (path: string): string | undefined => {
  let fd: number
  try {
    fd = fs.openSync(path, "r")
  } catch {
    return undefined
  }
  try {
    const size = fs.fstatSync(fd).size
    const length = Math.min(size, daemonLogTail)
    const buffer = Buffer.alloc(length)
    fs.readSync(fd, buffer, 0, length, size - length)
    const text = buffer.toString("utf8")
    return size > length ? text.slice(text.indexOf("\n") + 1) : text
  } finally {
    fs.closeSync(fd)
  }
}

const stamp = (date: Date) => date.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")

interface Written {
  readonly path: string
  readonly entries: ReadonlyArray<{ readonly name: string; readonly about: string }>
  readonly payloads: boolean
}

const write = (options: {
  readonly paths: Paths.Paths["Service"]
  readonly output: string | undefined
  readonly includePayloads: boolean
  readonly daemon: unknown
  readonly now: Date
}): Written => {
  const { paths, includePayloads, now } = options
  const name = `exangelos-debug-${stamp(now)}`
  const reports = Path.join(paths.stateDir, "reports")
  const out = options.output === undefined ? Path.join(reports, `${name}.tar.gz`) : Path.resolve(options.output)
  fs.mkdirSync(Path.dirname(out), { recursive: true, mode: 0o700 })
  const stage = fs.mkdtempSync(Path.join(os.tmpdir(), "exangelos-debug-"))
  try {
    const root = Path.join(stage, name)
    fs.mkdirSync(Path.join(root, "logs"), { recursive: true, mode: 0o700 })
    const entries: Array<{ name: string; about: string }> = []
    const put = (relative: string, content: string, about: string) => {
      fs.writeFileSync(Path.join(root, relative), content, { mode: 0o600 })
      entries.push({ name: `${name}/${relative}`, about })
    }
    let skipped = 0
    const logFiles: Array<string> = []
    for (const src of Record.sources) {
      for (const file of Read.files(paths.logDir, src)) {
        let text: string
        try {
          text = fs.readFileSync(file, "utf8")
        } catch {
          continue
        }
        const lines: Array<string> = []
        for (const line of text.split("\n")) {
          if (line === "") continue
          const record = Record.parse(line)
          if (Option.isNone(record)) skipped++
          else lines.push(Record.encode(cleanRecord(record.value, includePayloads)))
        }
        logFiles.push(Path.basename(file))
        put(`logs/${Path.basename(file)}`, lines.length === 0 ? "" : `${lines.join("\n")}\n`, `${src} log records, redacted`)
      }
    }
    const daemonLog = tailOf(paths.logFile)
    if (daemonLog !== undefined) put("daemon.log", scrub(daemonLog), "the end of the service's own output, redacted")
    const settings = readJson(paths.settingsFile)
    const levelSetting = typeof settings === "object" && settings !== null && "logLevel" in settings
      ? settings.logLevel
      : undefined
    const report = {
      generatedAt: now.toISOString(),
      exangelos: { version: Build.version, executable: process.execPath, digest: digest(process.execPath) },
      os: { platform: process.platform, arch: process.arch, release: os.release(), bun: process.versions.bun },
      installMethod: InstallMethod.detect(fs.realpathSync(process.execPath)),
      paths: {
        configDir: paths.configDir,
        dataDir: paths.dataDir,
        stateDir: paths.stateDir,
        settingsFile: paths.settingsFile,
        databaseFile: paths.databaseFile,
        connectorDir: paths.connectorDir,
        socketPath: paths.socketPath,
        logDir: paths.logDir,
        logFile: paths.logFile
      },
      logLevel: {
        setting: levelSetting ?? "info",
        envVar: Level.envVar,
        envVarSet: (process.env[Level.envVar] ?? "") !== ""
      },
      settings,
      daemon: options.daemon,
      ...(typeof options.daemon === "object" && options.daemon !== null && "running" in options.daemon &&
          options.daemon.running === false
        ? { connectorDirectory: installed(paths.connectorDir) }
        : {}),
      logs: { files: logFiles, payloads: includePayloads ? "included" : "dropped", skippedLines: skipped }
    }
    put("report.json", `${JSON.stringify(report, null, 2)}\n`, "versions, digests, connectors, settings without secrets, OS, install method, paths")
    entries.unshift(entries.pop()!)
    fs.rmSync(out, { force: true })
    const tar = spawnSync("tar", ["-czf", out, "-C", stage, name], { encoding: "utf8" })
    if (tar.error !== undefined) throw new Error(`tar did not run: ${tar.error.message}`)
    if (tar.status !== 0) throw new Error(`tar exited with ${tar.status}: ${tar.stderr.trim()}`)
    fs.chmodSync(out, 0o600)
    return { path: out, entries, payloads: includePayloads }
  } finally {
    fs.rmSync(stage, { recursive: true, force: true })
  }
}

const text = (written: Written) =>
  [
    `Wrote ${written.path}`,
    "It holds:",
    ...written.entries.map((entry) => `  ${entry.name}  ${entry.about}`),
    written.payloads
      ? "Event payloads are included."
      : "Event payloads are left out; add --include-payloads to keep them.",
    "Nothing was sent anywhere. Secrets are redacted, but read the files before you attach the archive to an issue."
  ].join("\n")

const report = Command.make(
  "report",
  {
    includePayloads: Flag.Boolean("include-payloads").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Keep the event payloads that debug-level records carry")
    ),
    output: Flag.String("output").pipe(
      Flag.withDescription("Where to write the archive, instead of <state dir>/reports"),
      Flag.optional
    )
  },
  ({ includePayloads, output }) =>
    Effect.gen(function*() {
      if (Option.isSome(SessionHeaders.detect(process.env))) {
        yield* Console.error(
          "Only you make debug reports, and this terminal runs inside an agent session. Run the command again from your own terminal."
        )
        return yield* new CommandFailed({ tag: "HumanRequired" })
      }
      const json = yield* Json
      const paths = yield* Paths.Paths
      const daemon = yield* daemonState(paths.socketPath)
      const written = yield* Effect.try({
        try: () =>
          write({ paths, output: Option.getOrUndefined(output), includePayloads, daemon, now: new Date() }),
        catch: (error) => (error instanceof Error ? error.message : String(error))
      }).pipe(
        Effect.tapError((error) => Console.error(`Writing the debug report failed: ${error}`)),
        Effect.mapError(() => new CommandFailed({ tag: "ReportFailed" }))
      )
      yield* Console.log(json ? JSON.stringify(written) : text(written))
    })
).pipe(
  Command.withDescription(
    "Write a .tar.gz of the recent logs, versions and settings with secrets removed, to attach to an issue"
  )
)

export const command = Command.make("debug").pipe(
  Command.withDescription("Collect what helps diagnose a problem"),
  Command.withSubcommands([report])
)
