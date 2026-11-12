import { describe, expect, it } from "@effect/vitest"
import { DateTime, Effect, Schema, Stream } from "effect"
import { Catalogue, Plugin, PluginTest } from "@exangelos/plugin-sdk"

const opened = Catalogue.event("issue.opened", {
  description: "An issue was opened",
  payload: Schema.Struct({ title: Schema.String, at: Schema.DateTimeUtc })
})
const closed = Catalogue.event("issue.closed", {
  description: "An issue was closed",
  payload: Schema.Struct({ title: Schema.String })
})

const occurredAt = DateTime.makeUnsafe("2026-11-12T10:00:00Z")

const issues = Plugin.make({
  events: [opened, closed],
  parameters: Catalogue.parameters({
    main: "repo",
    schema: Schema.Struct({ repo: Schema.Trim.check(Schema.isNonEmpty()), label: Schema.optionalKey(Schema.String) })
  }),
  configuration: [
    Catalogue.text("host", { label: "Host" }),
    Catalogue.choice("scope", { label: "Scope", choices: ["mine", "all"], required: false }),
    Catalogue.secret("token", { label: "Token" })
  ],
  handlers: Effect.succeed({
    configure: (values) =>
      values.token === "bad" ? Effect.fail(new Plugin.ConfigurationRejected({ reason: "Token refused" })) : Effect.void,
    describe: (parameters) => Effect.succeed({ subject: parameters.repo, label: `Issues in ${parameters.repo}` }),
    watch: ({ parameters }) =>
      Stream.make(
        opened.item({
          occurredAt,
          summary: "Opened",
          payload: { title: parameters.repo, at: occurredAt },
          dedupeKey: "1",
          cursor: "c1"
        }),
        closed.item({ occurredAt, summary: "Closed", payload: { title: "x" }, dedupeKey: "2", cursor: "c2" }),
        Plugin.end("Repository archived"),
        Plugin.cursor("never sent")
      )
  })
})

describe("Plugin", () => {
  it.effect("hands the declared catalogue over in the handshake", () =>
    Effect.gen(function*() {
      const client = yield* PluginTest.makeClient(issues)
      const { protocolVersion, catalogue } = yield* client.Handshake()

      expect(protocolVersion).toBe(1)
      expect(catalogue.eventTypes.map((spec) => spec.type)).toEqual(["issue.opened", "issue.closed"])
      expect(catalogue.eventTypes[0].payload).toMatchObject({
        type: "object",
        properties: { title: { type: "string" } },
        required: ["title", "at"]
      })
      expect(catalogue.parameters.main).toBe("repo")
      expect(catalogue.parameters.schema).toMatchObject({ type: "object", required: ["repo"] })
      expect(catalogue.configuration).toEqual([
        { _tag: "Text", key: "host", label: "Host", required: true, secretDestination: false },
        { _tag: "Choice", key: "scope", label: "Scope", required: false, choices: ["mine", "all"], secretDestination: false },
        { _tag: "Secret", key: "token", label: "Token", required: true }
      ])
    }).pipe(Effect.scoped))

  it.effect("rejects a configuration missing a required field or refused by the plugin", () =>
    Effect.gen(function*() {
      const client = yield* PluginTest.makeClient(issues)

      expect(yield* client.Configure({ values: { host: "h", token: "t" } })).toEqual({ _tag: "Accepted" })
      expect(yield* client.Configure({ values: { host: "h" } })).toEqual({
        _tag: "Rejected",
        reason: "Missing required field: token"
      })
      expect(yield* client.Configure({ values: { host: "h", token: "bad" } })).toEqual({
        _tag: "Rejected",
        reason: "Token refused"
      })
    }).pipe(Effect.scoped))

  it.effect("describes normalised parameters or says why they are invalid", () =>
    Effect.gen(function*() {
      const client = yield* PluginTest.makeClient(issues)

      expect(yield* client.Describe({ parameters: { repo: "  acme/app " } })).toEqual({
        _tag: "Described",
        parameters: { repo: "acme/app" },
        subject: "acme/app",
        label: "Issues in acme/app"
      })
      const invalid = yield* client.Describe({ parameters: { label: "x" } })
      expect(invalid._tag).toBe("Invalid")
    }).pipe(Effect.scoped))

  it.effect("streams only the selected event types, keeps their cursors and stops at the end", () =>
    Effect.gen(function*() {
      const client = yield* PluginTest.makeClient(issues)
      const items = yield* client.Watch({ parameters: { repo: "acme/app" }, eventTypes: [closed.type] }).pipe(
        Stream.runCollect
      )

      expect(items).toEqual([
        { _tag: "Cursor", cursor: "c1" },
        {
          _tag: "Event",
          event: { type: "issue.closed", occurredAt, summary: "Closed", payload: { title: "x" }, dedupeKey: "2" },
          cursor: "c2"
        },
        { _tag: "End", reason: "Repository archived" }
      ])
    }).pipe(Effect.scoped))

  it.effect("sends event payloads in their JSON encoding", () =>
    Effect.gen(function*() {
      const client = yield* PluginTest.makeClient(issues)
      const [first] = yield* client.Watch({ parameters: { repo: "acme/app" }, eventTypes: [] }).pipe(
        Stream.take(1),
        Stream.runCollect
      )

      expect(first).toMatchObject({
        _tag: "Event",
        event: { payload: { title: "acme/app", at: "2026-11-12T10:00:00.000Z" } }
      })
    }).pipe(Effect.scoped))
})
