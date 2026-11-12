import { describe, expect, it } from "@effect/vitest"
import { Effect, Fiber, Layer, Stream } from "effect"
import { TestClock } from "effect/testing"
import { PluginTest } from "@exangelos/plugin-sdk"
import { GitHub, GithubPr } from "../src/index.ts"
import * as Stub from "./stubGitHub.ts"

const token = "ghp_stubbedtoken"

const client = (answers: ReadonlyArray<Stub.Answer>) =>
  Effect.gen(function*() {
    const stub = yield* Stub.make(answers)
    const plugin = { layer: GithubPr.plugin.layer.pipe(Layer.provide(GitHub.layer), Layer.provide(stub.layer)) }
    return { client: yield* PluginTest.makeClient(plugin), sent: stub.sent }
  })

describe("github-pr plugin", () => {
  it.effect("hands over a catalogue of the nine event types", () =>
    Effect.gen(function*() {
      const { client: plugin } = yield* client([])
      const { catalogue } = yield* plugin.Handshake()

      expect(catalogue.eventTypes.map((e) => e.type)).toEqual([
        "head.changed",
        "base.changed",
        "conflict.detected",
        "checks.failed",
        "checks.passed",
        "review.submitted",
        "review.thread",
        "comment.added",
        "merge.ready"
      ])
      expect(catalogue.parameters.main).toBe("pullRequest")
      expect(catalogue.configuration.map((f) => [f._tag, f.key])).toEqual([["Secret", "token"], ["Text", "host"]])
    }).pipe(Effect.scoped))

  it.effect("names a pull request as its subject and refuses what is not one", () =>
    Effect.gen(function*() {
      const { client: plugin } = yield* client([])

      expect(yield* plugin.Describe({ parameters: { pullRequest: "https://github.com/acme/api/pull/7" } })).toEqual({
        _tag: "Described",
        parameters: { pullRequest: "acme/api#7" },
        subject: "acme/api#7",
        label: "Pull request acme/api#7"
      })
      expect(yield* plugin.Describe({ parameters: { pullRequest: "acme/api" } })).toMatchObject({ _tag: "Invalid" })
      expect(yield* plugin.Describe({ parameters: { pullRequest: "acme/api#7", ignoreAuthors: ["(bot"] } }))
        .toMatchObject({ _tag: "Invalid" })
    }).pipe(Effect.scoped))

  it.effect("rejects a token GitHub refuses, without repeating the token", () =>
    Effect.gen(function*() {
      const { client: plugin } = yield* client([Stub.badCredentials])
      const answer = yield* plugin.Configure({ values: { token } })

      expect(answer).toMatchObject({ _tag: "Rejected", reason: expect.stringContaining("Bad credentials") })
      expect(JSON.stringify(answer)).not.toContain(token)
      const error = yield* plugin.Watch({ parameters: { pullRequest: "acme/api#7" }, eventTypes: [] }).pipe(
        Stream.runCollect,
        Effect.flip
      )
      expect(error._tag).toBe("CredentialsRejected")
    }).pipe(Effect.scoped))

  it.effect("watches until the pull request is merged, moving the cursor with each poll", () =>
    Effect.gen(function*() {
      const failing = { checks: [{ id: "CR_1", name: "build", conclusion: "FAILURE" }] }
      const { client: plugin, sent } = yield* client([
        Stub.viewer,
        Stub.pullRequest(failing),
        Stub.pullRequest({
          ...failing,
          comments: [{ id: "IC_1", login: "ana", body: "Fixing the build", createdAt: "2026-11-12T12:00:30Z" }]
        }),
        Stub.pullRequest({ ...failing, state: "MERGED" })
      ])
      expect(yield* plugin.Configure({ values: { token, host: "github.acme.dev" } })).toEqual({ _tag: "Accepted" })

      const fiber = yield* plugin.Watch({ parameters: { pullRequest: "acme/api#7" }, eventTypes: [] }).pipe(
        Stream.runCollect,
        Effect.forkChild
      )
      yield* TestClock.adjust("3 minutes")
      const items = yield* Fiber.join(fiber)

      expect(items.map((item) => item._tag === "Event" ? item.event.dedupeKey : item._tag)).toEqual([
        `checks.failed/${"a".repeat(40)}/CR_1`,
        "comment.added/IC_1",
        "End"
      ])
      const [first, second, end] = items
      expect(first?._tag === "Event" && second?._tag === "Event" && first.cursor !== second.cursor).toBe(true)
      expect(end).toEqual({ _tag: "End", reason: "The pull request was merged" })
      expect(JSON.stringify(items)).not.toContain(token)
      expect((yield* sent).map((s) => s.url)).toEqual(Array(4).fill("https://github.acme.dev/api/graphql"))
    }).pipe(Effect.scoped))
})
