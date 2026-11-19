import { afterEach, describe, expect, it } from "@effect/vitest"
import { Cause, ConfigProvider, Effect, Layer, Logger, References } from "effect"
import { FileLog, Level, Record, Redact, Secrets } from "../src/index.ts"

const capture = (lines: Array<string>) =>
  Layer.mergeAll(
    Logger.layer([FileLog.fileLogger("daemon", { file: "memory", write: (line) => lines.push(line) })]),
    Layer.succeed(References.MinimumLogLevel, "Trace")
  )

afterEach(() => Secrets.clear())

describe("Redact", () => {
  it("hides values under sensitive keys at any depth", () => {
    expect(Redact.redactValue({
      connector: "jira",
      apiToken: "abc",
      nested: [{ Cookie: "c=1", password: { any: "thing" } }, { safe: "kept" }]
    }, [])).toEqual({
      connector: "jira",
      apiToken: "[redacted]",
      nested: [{ Cookie: "[redacted]", password: "[redacted]" }, { safe: "kept" }]
    })
  })

  it("hides known secret values inside any string, leaving no fragment of overlaps", () => {
    expect(Redact.redactText("got abcdef and cdefgh, abcx", ["abcdef", "cdefgh", "abc"])).toBe("got [redacted] and [redacted], abcx")
    expect(Redact.redactText("abcdefgh", ["abcdef", "cdefgh"])).toBe("[redacted]")
  })

  it("hides a secret shorter than four characters only where it stands as a whole word", () => {
    expect(Redact.redactText("configure probe qZ7", ["qZ7"])).toBe("configure probe [redacted]")
    expect(Redact.redactText("{\"token\":\"qZ7\"} qZ7x xqZ7 qZ7_", ["qZ7"])).toBe("{\"token\":\"[redacted]\"} qZ7x xqZ7 qZ7_")
    Secrets.register(["", "a1"])
    expect(Secrets.values()).toEqual(["a1"])
  })

  it("keeps the daemon's own annotation keys when a secret matches one", () => {
    const record = Redact.redactRecord(
      { t: "t", level: "DEBUG", src: "daemon", pid: 1, msg: "event payload", ann: { payload: { payload: 1 }, connector: "echo", extra_payload: 2 } },
      ["payload"]
    )
    expect(record.msg).toBe("event [redacted]")
    expect(record.ann).toEqual({ payload: { "[redacted]": 1 }, connector: "echo", "extra_[redacted]": 2 })
  })

  it("registers the values of sensitive environment variables, leaving short flags and other names", () => {
    Secrets.registerEnvironment({ GITHUB_TOKEN: "ghp-value", API_KEY: "1", HOME: "/home/someone", SESSION_COOKIE: undefined })
    expect(Secrets.values()).toEqual(["ghp-value"])
  })

  it("sanitises failure text: known secrets go, and addresses keep only scheme, host and path", () => {
    Secrets.register(["hunter22"])
    expect(Redact.sanitise("GET https://me:pw@api.example/v1/items?key=1#frag failed with hunter22"))
      .toBe("GET https://api.example/v1/items failed with [redacted]")
    expect(Redact.sanitise("see https://api.example/token/abc")).toBe("see https://api.example/[redacted]")
  })

  it.effect("redacts message parts, annotations and the cause of a logged record", () =>
    Effect.gen(function*() {
      Secrets.register(["s3cret-value", "abc", "4242424242"])
      const lines: Array<string> = []
      yield* Effect.logError("echo s3cret-value", { header: "Bearer s3cret-value", authorization: "x" }, Cause.fail("boom s3cret-value")).pipe(
        Effect.annotateLogs({ connector: "jira", detail: { token: "t", note: "s3cret-value" }, pin: 4242424242n }),
        Effect.withLogSpan("open s3cret-value"),
        Effect.provide(capture(lines))
      )
      const text = lines.join("\n")
      expect(text).not.toContain("s3cret-value")
      const record = Record.parse(lines[0]!)
      expect(record._tag).toBe("Some")
      if (record._tag === "Some") {
        expect(record.value.msg).toBe("echo [redacted] {\"header\":\"Bearer [redacted]\",\"authorization\":\"[redacted]\"}")
        expect(record.value.ann).toEqual({ connector: "jira", detail: { token: "[redacted]", note: "[redacted]" }, pin: "[redacted]" })
        expect(Object.keys(record.value.spans ?? {})).toEqual(["open [redacted]"])
        expect(record.value.cause).toContain("boom [redacted]")
      }
    }))

  it.effect("keeps an event payload only at DEBUG and below", () =>
    Effect.gen(function*() {
      yield* Level.init("debug").pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord({}))))
      const lines: Array<string> = []
      const logged = (log: Effect.Effect<void>) =>
        log.pipe(Effect.annotateLogs({ payload: { title: "x" } }), Effect.provide(capture(lines)))
      yield* Level.init("trace").pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord({}))))
      yield* logged(Effect.logInfo("event"))
      yield* logged(Effect.logDebug("event"))
      yield* logged(Effect.logTrace("event"))
      expect(lines.map((line) => JSON.parse(line).ann?.payload !== undefined)).toEqual([false, true, false])
    }).pipe(Effect.ensuring(Level.init(undefined).pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord({})))))))

  it("keeps the readable form of errors, dates and big numbers", () => {
    expect(Redact.redactValue({
      error: new Error("failed with abcdef"),
      at: new Date("2026-11-19T10:00:00.000Z"),
      size: 12n
    }, ["abcdef"])).toEqual({
      error: { name: "Error", message: "failed with [redacted]" },
      at: "2026-11-19T10:00:00.000Z",
      size: "12"
    })
  })

  it.effect("writes a stand-in when an annotation cannot be read", () =>
    Effect.gen(function*() {
      const lines: Array<string> = []
      const broken = { get detail(): string { throw new Error("unreadable") } }
      const worse = { get detail(): string { throw Object.create(null) } }
      yield* Effect.logWarning("odd").pipe(Effect.annotateLogs({ broken }), Effect.provide(capture(lines)))
      yield* Effect.logWarning("odd").pipe(Effect.annotateLogs({ worse }), Effect.provide(capture(lines)))
      expect(lines.map((line) => JSON.parse(line).msg)).toEqual([
        "a log record could not be written: Error: unreadable",
        "a log record could not be written: an unprintable error"
      ])
    }))
})
