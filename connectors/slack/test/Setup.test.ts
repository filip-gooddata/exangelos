import { ledgerProcess } from "./LedgerProcess.ts"
import { expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { ConnectorTest } from "@exangelos/connector-sdk"
import { make } from "../src/Slack.ts"
import { type Request } from "../src/Source.ts"

it.effect("discovers only through consented Configure and passes the exact private selection to acquisition", () => Effect.gen(function*() {
  const calls: Array<unknown> = []
  const request: typeof Request.Type = { selection: { workspace: "T0000002", owner: "U0000003", conversations: ["C0000004"] }, key: "ab".repeat(32), expectedScope: "aa".repeat(32), root: "/synthetic/renamed-home/cache" }
  let observedScope = "aa".repeat(32)
  const client = yield* ConnectorTest.makeClient(make({
    setup: (values) => Effect.sync(() => { calls.push(values); return request }),
    read: (actual) => Effect.sync(() => {
      calls.push(actual)
      return { scope: observedScope, complete: true as const, messages: [], generation: "1", snapshot: "bb".repeat(32) }
    })
  }))
  const handshake = yield* client.Handshake()
  expect(handshake.catalogue.configuration.find((field) => field.key === "sourceMode")).toMatchObject({ _tag: "Choice", choices: ["persisted-cache"] })
  yield* client.Describe({ parameters: { selection: "selected" } })
  expect(calls).toEqual([])
  expect((yield* client.Configure({ values: { conversationSnippet: "synthetic body" } }))._tag).toBe("Rejected")
  expect(calls).toEqual([])
  const values = { sourceMode: "persisted-cache", conversationSnippet: "synthetic body", cacheRoot: "/synthetic/renamed-home/cache" }
  expect((yield* client.Configure({ values }))._tag).toBe("Accepted")
  expect(calls).toEqual([values, request])
  expect((yield* client.Configure({ values: { ...values, privateSource: JSON.stringify(request) } }))._tag).toBe("Rejected")
  expect((yield* client.Describe({ parameters: { selection: "selected" } }))._tag).toBe("Invalid")
  expect(calls).toEqual([values, request])
  observedScope = "cc".repeat(32)
  expect((yield* client.Configure({ values }))._tag).toBe("Rejected")
  expect((yield* client.Describe({ parameters: { selection: "selected" } }))._tag).toBe("Invalid")
  expect(calls).toEqual([values, request, values, request])
}).pipe(Effect.provide(ledgerProcess), Effect.scoped))
