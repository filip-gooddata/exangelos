import { ledgerProcess } from "./LedgerProcess.ts"
import { expect, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Stream } from "effect"
import { ConnectorTest } from "@exangelos/connector-sdk"
import { make } from "../src/Slack.ts"

it.effect("resolves only after consent and discards the raw reference after Describe", () => Effect.gen(function*() {
  const calls: Array<unknown> = []
  const expectedScope = "aa".repeat(32)
  const client = yield* ConnectorTest.makeClient(make({
    setup: (values) => Effect.sync(() => {
      calls.push(values)
      return { selection: { workspace: "T0000001", owner: "U0000001", conversations: ["C0000001"] },
        key: "bb".repeat(32), expectedScope, label: "Thread in #fixture" }
    }),
    read: () => Effect.die("Unexpected acquisition")
  }))
  const parameters = { selection: "C0000001:1700000000.000001", scope: "replies" }
  const describe = () => client.Describe({ parameters })
  const configure = (values: Record<string, string>) => client.Configure({ values })
  expect((yield* configure({ sourceMode: "persisted-cache" }))._tag).toBe("Rejected")
  expect((yield* describe())._tag).toBe("Invalid")
  const consent = { subscriptionAccess: "persisted-cache", cacheRoot: "/synthetic/cache" }
  expect((yield* configure(consent))._tag).toBe("Accepted")
  expect((yield* client.Describe({ parameters: { selection: "selected" } }))._tag).toBe("Invalid")
  expect((yield* client.Describe({ parameters: { ...parameters, scope: "fixture-private" } }))).toEqual({
    _tag: "Invalid", reason: "Use scope=conversation or scope=replies with a Slack message reference"
  })
  for (const malformed of [{ selection: { secret: "fixture-private" } }, { selection: "C0000001", scope: ["fixture-private"] }]) {
    const result = yield* client.Describe({ parameters: malformed })
    expect(result._tag).toBe("Invalid")
    expect(JSON.stringify(result)).not.toContain("fixture-private")
  }
  expect(calls).toEqual([])
  expect(yield* describe()).toEqual({ _tag: "Described", subject: `slack:${expectedScope}`,
    label: "Thread in #fixture", parameters: { selection: `scope-${expectedScope}` } })
  expect(calls).toEqual([{ ...consent, subject: parameters.selection, scope: "replies" }])
  expect((yield* configure({ subscriptionAccess: "disabled" }))._tag).toBe("Accepted")
  expect((yield* describe())._tag).toBe("Invalid")
  expect(calls).toHaveLength(1)
}).pipe(Effect.provide(ledgerProcess), Effect.scoped))

it.effect("revoking and re-enabling while a read is pending closes the old watch", () => Effect.gen(function*() {
  const started = yield* Deferred.make<void>()
  const finish = yield* Deferred.make<void>()
  const scope = "aa".repeat(32)
  const client = yield* ConnectorTest.makeClient(make({
    setup: () => Effect.succeed({ selection: { workspace: "T0000001", owner: "U0000001", conversations: ["C0000001"] },
      key: "bb".repeat(32), expectedScope: scope, label: "#fixture" }),
    read: () => Effect.gen(function*() {
      yield* Deferred.succeed(started, undefined)
      yield* Deferred.await(finish)
      return { scope, complete: true as const, messages: [], generation: "1", snapshot: "cc".repeat(32) }
    })
  }))
  const configure = (subscriptionAccess: string) => client.Configure({ values: { subscriptionAccess } })
  yield* configure("persisted-cache")
  const watch = yield* client.Watch({ parameters: { selection: `scope-${scope}` }, eventTypes: [] }).pipe(
    Stream.take(1), Stream.runCollect, Effect.flip, Effect.forkChild
  )
  yield* Deferred.await(started)
  yield* configure("disabled")
  yield* configure("persisted-cache")
  yield* Deferred.succeed(finish, undefined)
  expect((yield* Fiber.join(watch))._tag).toBe("SourceFailed")
}).pipe(Effect.provide(ledgerProcess), Effect.scoped))
