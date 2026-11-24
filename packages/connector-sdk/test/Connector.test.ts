import { describe, expect, it } from "@effect/vitest"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { DateTime, Duration, Effect, Schema, Stream } from "effect"
import { Catalogue, Connector, ConnectorTest } from "@exangelos/connector-sdk"

const opened = Catalogue.event("issue.opened", {
  description: "An issue was opened",
  payload: Schema.Struct({ title: Schema.String, at: Schema.DateTimeUtc })
})
const closed = Catalogue.event("issue.closed", {
  description: "An issue was closed",
  payload: Schema.Struct({ title: Schema.String })
})

const occurredAt = DateTime.makeUnsafe("2026-11-12T10:00:00Z")

const windowed = Connector.make({
  events: [closed],
  parameters: Catalogue.parameters({ main: "repo", schema: Schema.Struct({ repo: Schema.String }) }),
  configuration: [],
  handlers: Effect.succeed({
    configure: () => Effect.void,
    describe: (parameters) => Effect.succeed({ subject: parameters.repo, label: parameters.repo }),
    watch: ({ wakeWindow }) => Stream.make(Connector.end(`${Duration.toMillis(wakeWindow)}`))
  })
})

const issues = Connector.make({
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
      values.token === "bad" ? Effect.fail(new Connector.ConfigurationRejected({ reason: "Token refused" })) : Effect.void,
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
        Connector.end("Repository archived"),
        Connector.cursor("never sent")
      )
  })
})

describe("Connector", () => {
  it.effect("hands the declared catalogue over in the handshake", () =>
    Effect.gen(function*() {
      const client = yield* ConnectorTest.makeClient(issues)
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

  it.effect("rejects a configuration missing a required field or refused by the connector", () =>
    Effect.gen(function*() {
      const client = yield* ConnectorTest.makeClient(issues)

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
      const client = yield* ConnectorTest.makeClient(issues)

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
      const client = yield* ConnectorTest.makeClient(issues)
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

  it.effect("hands the daemon's wake window to the Watch handler, 5 s when the daemon sends none", () =>
    Effect.gen(function*() {
      const client = yield* ConnectorTest.makeClient(windowed)
      const watch = (wakeWindow?: Duration.Duration) =>
        client.Watch({ parameters: { repo: "acme/app" }, eventTypes: [], ...(wakeWindow ? { wakeWindow } : {}) }).pipe(
          Stream.runCollect
        )

      expect(yield* watch(Duration.millis(1234))).toEqual([{ _tag: "End", reason: "1234" }])
      expect(yield* watch()).toEqual([{ _tag: "End", reason: "5000" }])
    }).pipe(Effect.scoped))

  it.effect("sends event payloads in their JSON encoding", () =>
    Effect.gen(function*() {
      const client = yield* ConnectorTest.makeClient(issues)
      const [first] = yield* client.Watch({ parameters: { repo: "acme/app" }, eventTypes: [] }).pipe(
        Stream.take(1),
        Stream.runCollect
      )

      expect(first).toMatchObject({
        _tag: "Event",
        event: { payload: { title: "acme/app", at: "2026-11-12T10:00:00.000Z" } }
      })
    }).pipe(Effect.scoped))

  it.effect("reads and returns parameters in their JSON encoding", () =>
    Effect.gen(function*() {
      const since = Connector.make({
        events: [closed],
        parameters: Catalogue.parameters({ main: "since", schema: Schema.Struct({ since: Schema.DateTimeUtc }) }),
        configuration: [],
        handlers: Effect.succeed({
          configure: () => Effect.void,
          describe: ({ since }) => Effect.succeed({ subject: DateTime.formatIso(since), label: "Since" }),
          watch: () => Stream.empty
        })
      })
      const client = yield* ConnectorTest.makeClient(since)

      expect(yield* client.Describe({ parameters: { since: "2026-11-12T10:00:00Z" } })).toEqual({
        _tag: "Described",
        parameters: { since: "2026-11-12T10:00:00.000Z" },
        subject: "2026-11-12T10:00:00.000Z",
        label: "Since"
      })
    }).pipe(Effect.scoped))

  it("refuses a main parameter that is not a required property", () => {
    expect(() =>
      Catalogue.parameters({ main: "label", schema: Schema.Struct({ label: Schema.optionalKey(Schema.String) }) })
    ).toThrow('The main parameter "label" must be a required property of an object schema')
  })
})

describe("Connector icon", () => {
  const withIcon = (icon: Effect.Effect<Connector.Icon | undefined, unknown>) =>
    Connector.make({
      events: [closed],
      parameters: Catalogue.parameters({ main: "repo", schema: Schema.Struct({ repo: Schema.String }) }),
      configuration: [],
      handlers: Effect.succeed({
        configure: () => Effect.void,
        describe: (parameters) => Effect.succeed({ subject: parameters.repo, label: parameters.repo }),
        watch: () => Stream.empty,
        icon
      })
    })
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47])

  it.effect("serves the bytes a connector's own icon hook finds, base64-encoded", () =>
    Effect.gen(function*() {
      const client = yield* ConnectorTest.makeClient(withIcon(Effect.succeed({ mediaType: "image/png", bytes: png })))
      expect(yield* client.Icon()).toEqual({ _tag: "Served", mediaType: "image/png", data: "iVBORw==" })
    }).pipe(Effect.scoped))

  it.effect("serves none when the hook finds none or fails", () =>
    Effect.gen(function*() {
      const none = yield* ConnectorTest.makeClient(withIcon(Effect.succeed(undefined)))
      const failing = yield* ConnectorTest.makeClient(withIcon(Connector.iconFile("/no/such/app/icon.png")))
      expect(yield* none.Icon()).toEqual({ _tag: "None" })
      expect(yield* failing.Icon()).toEqual({ _tag: "None" })
    }).pipe(Effect.scoped))
})

describe("manifestIconIn", () => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg"/>`

  it.live("serves the manifest icon inside the connector and refuses one that leads outside it or is too large", () =>
    Effect.gen(function*() {
      const root = yield* Effect.acquireRelease(
        Effect.promise(async () => Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "sdk-icon-")))),
        (directory) => Effect.promise(() => Fs.rm(directory, { recursive: true, force: true }))
      )
      const connector = (name: string, icon: string) =>
        Effect.promise(async () => {
          await Fs.mkdir(Path.join(root, name))
          await Fs.writeFile(Path.join(root, name, "connector.json"), JSON.stringify({ icon }))
          return Path.join(root, name)
        })
      yield* Effect.promise(async () => {
        await Fs.writeFile(Path.join(root, "outside.svg"), svg)
      })
      const inside = yield* connector("inside", "icon.svg")
      yield* Effect.promise(() => Fs.writeFile(Path.join(inside, "icon.svg"), svg))
      const parent = yield* connector("parent", "../outside.svg")
      const linked = yield* connector("linked", "icon.svg")
      yield* Effect.promise(() => Fs.symlink(Path.join(root, "outside.svg"), Path.join(linked, "icon.svg")))
      const large = yield* connector("large", "icon.png")
      yield* Effect.promise(() => Fs.writeFile(Path.join(large, "icon.png"), new Uint8Array(Connector.maxIconBytes + 1)))

      expect((yield* Connector.manifestIconIn(inside))?.mediaType).toBe("image/svg+xml")
      expect((yield* Effect.flip(Connector.manifestIconIn(parent))).reason).toContain("leads outside the connector")
      expect((yield* Effect.flip(Connector.manifestIconIn(linked))).reason).toContain("leads outside the connector")
      expect((yield* Effect.flip(Connector.manifestIconIn(large))).reason).toContain("over the 32768 byte limit")
    }).pipe(Effect.scoped))
})
