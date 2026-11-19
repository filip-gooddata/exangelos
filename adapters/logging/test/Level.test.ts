import { describe, expect, it } from "@effect/vitest"
import { ConfigProvider, Effect, Layer, Logger, Option, References } from "effect"
import { FileLog, Level } from "../src/index.ts"

const withEnv = (env: Record<string, string>) => Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord(env)))

const levels = (lines: Array<string>) => lines.map((line) => JSON.parse(line).level)

describe("Level", () => {
  it("reads names in any case", () => {
    expect(Level.parse("DEBUG")).toEqual(Option.some("Debug"))
    expect(Level.parse("warning")).toEqual(Option.some("Warn"))
    expect(Level.parse("loud")).toEqual(Option.none())
  })

  it.effect("follows the setting and its live changes, filtering the file log", () =>
    Effect.gen(function*() {
      const lines: Array<string> = []
      const logs = Layer.mergeAll(
        Logger.layer([FileLog.fileLogger("cli", { file: "memory", write: (line) => lines.push(line) })]),
        Layer.succeed(References.MinimumLogLevel, "Trace")
      )
      const both = Effect.logDebug("detail").pipe(Effect.andThen(Effect.logWarning("problem")), Effect.provide(logs))
      yield* Level.init(undefined).pipe(withEnv({}))
      yield* both
      yield* Level.apply("debug")
      yield* both
      yield* Level.apply("error")
      yield* both
      expect(levels(lines)).toEqual(["WARN", "DEBUG", "WARN"])
    }).pipe(Effect.ensuring(Level.init(undefined).pipe(withEnv({})))))

  it.effect("lets EXANGELOS_LOG_LEVEL override the setting and its changes", () =>
    Effect.gen(function*() {
      yield* Level.init("error").pipe(withEnv({ EXANGELOS_LOG_LEVEL: "trace" }))
      expect(Level.current()).toBe("Trace")
      expect(Level.pinned()).toBe(true)
      yield* Level.apply("warn")
      expect(Level.current()).toBe("Trace")
      yield* Level.init("error").pipe(withEnv({ EXANGELOS_LOG_LEVEL: "nonsense" }))
      expect(Level.current()).toBe("Error")
    }).pipe(Effect.ensuring(Level.init(undefined).pipe(withEnv({})))))
})
