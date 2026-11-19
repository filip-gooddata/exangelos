import { Console, Effect, Option } from "effect"
import { Command, Flag } from "effect/cli"
import { Level, Read, Record } from "@exangelos/logging"
import { Paths } from "@exangelos/paths"
import { CommandFailed, Json } from "./Output.ts"

const invalid = (message: string) =>
  Console.error(message).pipe(Effect.andThen(Effect.fail(new CommandFailed({ tag: "InputInvalid" }))))

const sinceOf = (text: Option.Option<string>) =>
  Option.match(text, {
    onNone: () => Effect.undefined,
    onSome: (value) =>
      Option.match(Read.since(value, new Date()), {
        onSome: Effect.succeed,
        onNone: () =>
          invalid(`--since takes a span such as 10m, 2h or 1d, or a time such as 2026-11-19T08:00:00Z, not "${value}".`)
      })
  })

export const command = Command.make(
  "logs",
  {
    follow: Flag.Boolean("follow").pipe(
      Flag.withAlias("f"),
      Flag.withDefault(false),
      Flag.withDescription("Keep printing records as they are written")
    ),
    level: Flag.Literals("level", Level.names).pipe(
      Flag.withDescription("Show records at this level and above"),
      Flag.optional
    ),
    since: Flag.String("since").pipe(
      Flag.withDescription("Show records from this far back, such as 10m, 2h or 1d, or from an ISO time"),
      Flag.optional
    ),
    connector: Flag.String("connector").pipe(Flag.withDescription("Show records about this connector"), Flag.optional),
    source: Flag.Literals("source", Record.sources).pipe(
      Flag.withDescription("Show records of one process: daemon, mcp or cli"),
      Flag.optional
    ),
    lines: Flag.Int("lines").pipe(
      Flag.withAlias("n"),
      Flag.withDefault(200),
      Flag.withDescription("How many of the most recent records to show first")
    )
  },
  (options) =>
    Effect.gen(function*() {
      const json = yield* Json
      const paths = yield* Paths.Paths
      if (options.lines < 0) return yield* invalid("--lines takes a whole number, 0 or more.")
      const since = yield* sinceOf(options.since)
      const filter: Record.Filter = {
        ...(Option.isSome(options.level) ? { level: options.level.value.toUpperCase() as Record.Level } : {}),
        ...(since !== undefined ? { since } : {}),
        ...(Option.isSome(options.connector) ? { connector: options.connector.value } : {})
      }
      const show = (records: ReadonlyArray<Record.LogRecord>) =>
        records.length === 0
          ? Effect.void
          : Console.log(records.map((record) => (json ? Record.encode(record) : Record.format(record))).join("\n"))
      const tail = new Read.Tail(paths.logDir, Option.isSome(options.source) ? [options.source.value] : Record.sources)
      const recent = tail.backlog().filter((record) => Record.matches(record, filter))
      yield* show(recent.slice(Math.max(0, recent.length - options.lines)))
      if (!options.follow) {
        if (recent.length === 0 && !json) yield* Console.error(`No log records match in ${paths.logDir}.`)
        return
      }
      return yield* Effect.sleep("250 millis").pipe(
        Effect.andThen(Effect.suspend(() => show(tail.poll().filter((record) => Record.matches(record, filter))))),
        Effect.forever
      )
    })
).pipe(
  Command.withDescription(
    "Show the local logs of the daemon, the MCP server and the CLI, oldest first; they never leave this machine"
  )
)
