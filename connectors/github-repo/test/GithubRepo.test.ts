import { describe, expect, it } from "@effect/vitest"
import { Effect, Fiber, Layer, Schema, Stream } from "effect"
import { TestClock } from "effect/testing"
import { ConnectorTest } from "@exangelos/connector-sdk"
import { Manifest } from "@exangelos/contracts"
import packageJson from "../package.json" with { type: "json" }
import manifest from "../connector.json" with { type: "json" }
import { GitHub, GithubRepo } from "../src/index.ts"
import * as Stub from "./stubGitHub.ts"

const token = "ghp_stubbedtoken"
const sha = (c: string) => c.repeat(40)
const panther = { repository: "acme/api", tags: "mic-lib-v4.45*", branches: "release/mic/4.45" }

const client = (answers: ReadonlyArray<Stub.Answer>) =>
  Effect.gen(function*() {
    const stub = yield* Stub.make(answers)
    const connector = { layer: GithubRepo.connector.layer.pipe(Layer.provide(GitHub.layer), Layer.provide(stub.layer)) }
    return { client: yield* ConnectorTest.makeClient(connector), sent: stub.sent }
  })

const dedupeKeys = (items: ReadonlyArray<{ readonly _tag: string }>) =>
  items.map((item) => item._tag === "Event" ? (item as unknown as { event: { dedupeKey: string } }).event.dedupeKey : item._tag)

describe("github-repo connector", () => {
  it("validates its manifest and names the bundle the build writes", () => {
    const decoded = Schema.decodeUnknownSync(Manifest.Manifest)(manifest)
    expect(decoded).toMatchObject({ name: "github-repo", entry: { _tag: "Bundle" }, icon: "icon.svg" })
    if (decoded.entry._tag === "Bundle") expect(packageJson.scripts.build).toContain(`--outfile=${decoded.entry.path}`)
  })

  it.effect("hands over its event types and names the repository as the subject", () =>
    Effect.gen(function*() {
      const { client: connector } = yield* client([])
      const { catalogue } = yield* connector.Handshake()
      expect(catalogue.eventTypes.map((e) => e.type)).toEqual([
        "tag.created",
        "tag.moved",
        "branch.created",
        "branch.moved",
        "branch.deleted",
        "release.published",
        "workflow.started",
        "workflow.completed"
      ])
      expect(catalogue.parameters.main).toBe("repository")

      expect(yield* connector.Describe({ parameters: { ...panther, repository: "https://github.com/acme/api.git" } }))
        .toEqual({
          _tag: "Described",
          subject: "acme/api",
          label: "Repository acme/api",
          parameters: { repository: "acme/api", tags: ["mic-lib-v4.45*"], branches: ["release/mic/4.45"] }
        })
      expect(yield* connector.Describe({ parameters: { repository: "acme/api", workflows: `["a.yaml","b.yml"]` } }))
        .toMatchObject({ _tag: "Described", parameters: { workflows: ["a.yaml", "b.yml"] } })
      for (const wrong of [{ repository: "acme" }, { repository: "acme/api" }, { repository: "acme/api", workflows: "a b" }]) {
        expect(yield* connector.Describe({ parameters: wrong })).toMatchObject({ _tag: "Invalid" })
      }
    }).pipe(Effect.scoped))

  it.effect("rejects a token GitHub refuses, without repeating the token", () =>
    Effect.gen(function*() {
      const { client: connector } = yield* client([Stub.badCredentials])
      const answer = yield* connector.Configure({ values: { token } })
      expect(answer).toMatchObject({ _tag: "Rejected", reason: expect.stringContaining("Bad credentials") })
      expect(JSON.stringify(answer)).not.toContain(token)
    }).pipe(Effect.scoped))

  it.effect("baselines silently, then reports a new tag and a moved branch, narrowing each list to its literal start", () =>
    Effect.gen(function*() {
      const { client: connector, sent } = yield* client([
        Stub.viewer,
        Stub.repository({
          t0: Stub.refs({ "mic-lib-v4.44.0": sha("1") }, { annotated: true }),
          b0: Stub.refs({ "release/mic/4.45": sha("2") })
        }),
        Stub.repository({
          t0: Stub.refs({ "mic-lib-v4.45.0": sha("3") }, { annotated: true }),
          b0: Stub.refs({ "release/mic/4.45": sha("4"), "release/mic/4.45-hotfix": sha("5") })
        })
      ])
      expect(yield* connector.Configure({ values: { token } })).toEqual({ _tag: "Accepted" })

      const fiber = yield* connector.Watch({ parameters: panther, eventTypes: [] }).pipe(
        Stream.take(3),
        Stream.runCollect,
        Effect.forkChild
      )
      yield* TestClock.adjust("1 minute")
      const items = yield* Fiber.join(fiber)

      expect(dedupeKeys(items)).toEqual([
        "Cursor",
        `tag.created/mic-lib-v4.45.0/${sha("3")}`,
        `branch.moved/release/mic/4.45/${sha("4")}`
      ])
      const requests = yield* sent
      expect(requests[1]).toMatchObject({
        url: "https://api.github.com/graphql",
        authorization: `Bearer ${token}`,
        variables: { owner: "acme", name: "api", t0: "mic-lib-v4.45", b0: "release/mic/4.45" }
      })
      expect(requests[1]!.query).toContain(`t0: refs(refPrefix: "refs/tags/", query: $t0, first: 100)`)
      expect(requests[1]!.query).not.toContain("releases(")
      expect(requests).toHaveLength(3)
    }).pipe(Effect.scoped))

  it.effect("keeps GitHub's time of the poll from the date header as the release boundary", () =>
    Effect.gen(function*() {
      const { client: connector } = yield* client([
        Stub.viewer,
        Stub.repository({ releases: Stub.releases([]) }, "Thu, 26 Nov 2026 08:00:00 GMT")
      ])
      yield* connector.Configure({ values: { token } })
      const items = yield* connector.Watch({ parameters: { repository: "acme/api", releases: "*" }, eventTypes: [] }).pipe(
        Stream.take(1),
        Stream.runCollect
      )
      const cursor = (items[0] as unknown as { cursor: string }).cursor
      expect(JSON.parse(cursor).releases).toMatchObject({ since: "2026-11-26T08:00:00.000Z", ids: [], drafts: [] })
    }).pipe(Effect.scoped))

  it.effect("reads further pages of a long ref list", () =>
    Effect.gen(function*() {
      const { client: connector, sent } = yield* client([
        Stub.viewer,
        Stub.repository({ t0: Stub.refs({ "v1": sha("1") }, { next: "c1" }) }),
        Stub.refsPage(Stub.refs({ "v2": sha("2") })),
        Stub.repository({ t0: Stub.refs({ "v1": sha("1") }, { next: "c1" }) }),
        Stub.refsPage(Stub.refs({ "v2": sha("2"), "v3": sha("3") }))
      ])
      yield* connector.Configure({ values: { token } })
      const fiber = yield* connector.Watch({ parameters: { repository: "acme/api", tags: "v*" }, eventTypes: [] }).pipe(
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild
      )
      yield* TestClock.adjust("1 minute")
      expect(dedupeKeys(yield* Fiber.join(fiber))).toEqual(["Cursor", `tag.created/v3/${sha("3")}`])
      expect((yield* sent)[2]!.variables).toMatchObject({ prefix: "refs/tags/", query: "v", after: "c1" })
    }).pipe(Effect.scoped))

  it.effect("asks for workflow runs with the last ETag and reports a run that starts and completes", () =>
    Effect.gen(function*() {
      const { client: connector, sent } = yield* client([
        Stub.viewer,
        Stub.runs([{ id: 10, conclusion: "success", updatedAt: "2026-11-25T00:00:00Z" }]),
        Stub.notModified,
        Stub.runs([
          { id: 11, conclusion: null, updatedAt: "2026-11-26T00:00:00Z" },
          { id: 10, conclusion: "success", updatedAt: "2026-11-25T00:00:00Z" }
        ]),
        Stub.runs([
          { id: 11, conclusion: "failure", updatedAt: "2026-11-26T00:00:00Z" },
          { id: 10, conclusion: "success", updatedAt: "2026-11-25T00:00:00Z" }
        ])
      ])
      yield* connector.Configure({ values: { token, host: "github.acme.dev" } })
      const fiber = yield* connector.Watch({
        parameters: { repository: "acme/api", workflows: "mic-release-publish.yaml" },
        eventTypes: []
      }).pipe(Stream.take(3), Stream.runCollect, Effect.forkChild)
      yield* TestClock.adjust("3 minutes")
      const items = yield* Fiber.join(fiber)

      expect(dedupeKeys(items)).toEqual(["Cursor", "workflow.started/11/1", "workflow.completed/11/1"])
      const requests = (yield* sent).slice(1)
      const url = "https://github.acme.dev/api/v3/repos/acme/api/actions/workflows/mic-release-publish.yaml/runs?per_page=20"
      expect(requests.map((r) => [r.method, r.url])).toEqual(Array(4).fill(["GET", url]))
      expect(requests.map((r) => r.ifNoneMatch)).toEqual([undefined, `"e10"`, `"e10"`, `"e11-10"`])
    }).pipe(Effect.scoped))

  it.effect("waits as long as a secondary rate limit asks, then polls again", () =>
    Effect.gen(function*() {
      const { client: connector, sent } = yield* client([
        Stub.viewer,
        Stub.secondaryLimit,
        Stub.repository({ t0: Stub.refs({}) }),
        Stub.repository({ t0: Stub.refs({ "v1": sha("1") }) })
      ])
      yield* connector.Configure({ values: { token } })
      const fiber = yield* connector.Watch({ parameters: { repository: "acme/api", tags: "v*" }, eventTypes: [] }).pipe(
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild
      )
      yield* TestClock.adjust("29 seconds")
      expect(yield* sent).toHaveLength(2)
      yield* TestClock.adjust("1 second")
      expect(yield* sent).toHaveLength(3)
      yield* TestClock.adjust("1 minute")
      expect(dedupeKeys(yield* Fiber.join(fiber))).toEqual(["Cursor", `tag.created/v1/${sha("1")}`])
    }).pipe(Effect.scoped))

  it.effect("waits out a rate limit on the workflow runs too", () =>
    Effect.gen(function*() {
      const { client: connector, sent } = yield* client([
        Stub.viewer,
        Stub.restSecondaryLimit,
        Stub.runs([{ id: 10, conclusion: "success", updatedAt: "2026-11-25T00:00:00Z" }]),
        Stub.runs([
          { id: 11, conclusion: "success", updatedAt: "2026-11-26T00:00:00Z" },
          { id: 10, conclusion: "success", updatedAt: "2026-11-25T00:00:00Z" }
        ])
      ])
      yield* connector.Configure({ values: { token } })
      const fiber = yield* connector.Watch({ parameters: { repository: "acme/api", workflows: "a.yaml" }, eventTypes: [] })
        .pipe(Stream.take(2), Stream.runCollect, Effect.forkChild)
      yield* TestClock.adjust("29 seconds")
      expect(yield* sent).toHaveLength(2)
      yield* TestClock.adjust("2 minutes")
      expect(dedupeKeys(yield* Fiber.join(fiber))).toEqual(["Cursor", "workflow.completed/11/1"])
    }).pipe(Effect.scoped))

  it.effect("fails only the watch, without retrying, when a pattern lists too many refs or Actions are off limits", () =>
    Effect.gen(function*() {
      const many = yield* client([
        Stub.viewer,
        Stub.repository({ t0: Stub.refs({ "v1": sha("1") }, { next: "c" }) }),
        Stub.refsPage(Stub.refs({ "v2": sha("2") }, { next: "c" }))
      ])
      yield* many.client.Configure({ values: { token } })
      const tooMany = yield* many.client.Watch({ parameters: { repository: "acme/api", tags: "v*" }, eventTypes: [] }).pipe(
        Stream.runCollect,
        Effect.flip
      )
      expect(tooMany).toMatchObject({ _tag: "SourceFailed", reason: expect.stringContaining("More than 1000 tags") })
      expect(yield* many.sent).toHaveLength(11)

      const forbidden = yield* client([Stub.viewer, Stub.actionsForbidden])
      yield* forbidden.client.Configure({ values: { token } })
      const refused = yield* forbidden.client.Watch({ parameters: { repository: "acme/api", workflows: "a.yaml" }, eventTypes: [] })
        .pipe(Stream.runCollect, Effect.flip)
      expect(refused).toMatchObject({ _tag: "SourceFailed", reason: expect.stringContaining("not accessible") })
    }).pipe(Effect.scoped))

  it.effect("fails the watch with the repository named when GitHub cannot find it", () =>
    Effect.gen(function*() {
      const { client: connector } = yield* client([Stub.viewer, Stub.notFound])
      yield* connector.Configure({ values: { token } })
      const error = yield* connector.Watch({ parameters: panther, eventTypes: [] }).pipe(Stream.runCollect, Effect.flip)
      expect(error).toMatchObject({ _tag: "SourceFailed", reason: expect.stringContaining("acme/api") })
    }).pipe(Effect.scoped))
})
