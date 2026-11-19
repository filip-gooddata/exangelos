import { Config, Effect, LogLevel, Option, Schema } from "effect"

export const names = ["error", "warn", "info", "debug", "trace"] as const
export const Name = Schema.Literals(names)
export type Name = typeof Name.Type

export const envVar = "EXANGELOS_LOG_LEVEL"

export const initial: LogLevel.LogLevel = "Info"

const byName: Record<Name, LogLevel.LogLevel> = {
  error: "Error",
  warn: "Warn",
  info: "Info",
  debug: "Debug",
  trace: "Trace"
}

/** Reads a level name in any case; "warning" is taken as warn. */
export const parse = (text: string): Option.Option<LogLevel.LogLevel> => {
  const name = text.trim().toLowerCase()
  const known = name === "warning" ? "warn" : name
  return Schema.is(Name)(known) ? Option.some(byName[known]) : Option.none()
}

export const fromSetting = (setting: Name | undefined): LogLevel.LogLevel =>
  setting === undefined ? initial : byName[setting]

const live: { level: LogLevel.LogLevel; pinned: boolean } = { level: initial, pinned: false }

/** The level the file logs filter against now. */
export const current = (): LogLevel.LogLevel => live.level

/** Whether the environment fixed the level, so settings changes leave it alone. */
export const pinned = (): boolean => live.pinned

export const enabled = (level: LogLevel.LogLevel): boolean => LogLevel.isGreaterThanOrEqualTo(level, live.level)

/** The level from EXANGELOS_LOG_LEVEL; an unknown name counts as unset. */
export const override = Effect.gen(function*() {
  return Option.flatMap(yield* Config.option(Config.String(envVar)), parse)
}).pipe(Effect.orElseSucceed(() => Option.none<LogLevel.LogLevel>()))

/** Sets the live level from the setting, or from EXANGELOS_LOG_LEVEL when that is set. */
export const init = (setting: Name | undefined) =>
  Effect.gen(function*() {
    const fixed = yield* override
    live.pinned = Option.isSome(fixed)
    live.level = Option.getOrElse(fixed, () => fromSetting(setting))
  })

/** Applies a changed setting unless EXANGELOS_LOG_LEVEL fixed the level. */
export const apply = (setting: Name | undefined) =>
  Effect.sync(() => {
    if (!live.pinned) live.level = fromSetting(setting)
  })
