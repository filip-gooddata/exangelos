import { ledgerProcess, ledgerTestTimeout } from "./LedgerProcess.ts"
import { expect, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Stream } from "effect"
import { ConnectorTest } from "@exangelos/connector-sdk"
import { TestClock } from "effect/testing"
import { SourceUnavailable, type Snapshot } from "../src/Source.ts"
import { make } from "../src/Slack.ts"

const token = (n: number) => n.toString(16).padStart(64, "0")
const privateSource = JSON.stringify({ selection: { workspace: "fixture-workspace", owner: "fixture-owner", conversations: ["fixture-conversation"] }, key: token(90) })
const message = { id: token(2), body: token(3), reply: false, reactions: [token(4)], reactionsComplete: true }
const baseline: typeof Snapshot.Type = { scope: token(1), complete: true, messages: [message], generation: "1", snapshot: token(10) }

it.effect("real Python ledger SDK configures a private selection and resumes a silent baseline with the cursor only after the batch", () => Effect.gen(function*() {
  let current: typeof Snapshot.Type = baseline
  const client = yield* ConnectorTest.makeClient(make({ read: () => Effect.sync(() => current) }))
  expect((yield* client.Configure({ values: { privateSource } }))._tag).toBe("Accepted")
  expect(yield* client.Describe({ parameters: { selection: "selected" } })).toMatchObject({
    _tag: "Described", subject: "slack:selected", label: "Selected Slack conversations", parameters: { selection: "selected" }
  })
  const items = yield* client.Watch({ parameters: { selection: "selected" }, eventTypes: [] }).pipe(Stream.take(1), Stream.runCollect)
  expect(items[0]?._tag).toBe("Cursor")
  if (items[0]?._tag !== "Cursor") throw new Error("Expected baseline cursor")
  current = { ...baseline, generation: "2", snapshot: token(11), messages: [{ ...message, body: token(5), reactions: [] }] }
  const batch = yield* client.Watch({ parameters: { selection: "selected" }, eventTypes: [], cursor: items[0].cursor }).pipe(Stream.take(2), Stream.runCollect)
  expect(batch.map((item) => item._tag === "Event" && item.event.type)).toEqual(["message.edited", "reaction.removed"])
  expect(batch[0]).not.toHaveProperty("cursor")
  expect(batch[1]).toHaveProperty("cursor")
  expect(batch.every((item) => item._tag === "Event" && JSON.stringify(item.event.payload) === '{"count":1}')).toBe(true)
  expect(JSON.stringify(batch)).not.toContain("fixture-")
}).pipe(Effect.provide(ledgerProcess), Effect.scoped), ledgerTestTimeout)

it.effect("real Python ledger SDK rejects private failures, clears invalid reconfiguration, and prevents scope replacement", () => Effect.gen(function*() {
  let current = baseline
  let fail = false
  const client = yield* ConnectorTest.makeClient(make({ read: () => Effect.suspend(() => fail
    ? Effect.fail(new SourceUnavailable({ reason: "Slack persisted snapshot is unavailable or unsupported" }))
    : Effect.succeed(current)) }))
  expect((yield* client.Describe({ parameters: { selection: "selected" } }))._tag).toBe("Invalid")
  yield* client.Configure({ values: { privateSource } })
  current = { ...baseline, scope: token(50) }
  const error = yield* client.Watch({ parameters: { selection: "selected" }, eventTypes: [] }).pipe(Stream.runCollect, Effect.flip)
  expect(error._tag).toBe("SourceFailed")
  fail = true
  const rejected = yield* client.Configure({ values: { privateSource } })
  expect(rejected._tag).toBe("Rejected")
  expect((yield* client.Describe({ parameters: { selection: "selected" } }))._tag).toBe("Invalid")
  expect(JSON.stringify(rejected)).not.toContain("fixture-")
  fail = false
  yield* client.Configure({ values: { privateSource } })
  expect((yield* client.Configure({ values: {} }))._tag).toBe("Rejected")
  expect((yield* client.Describe({ parameters: { selection: "selected" } }))._tag).toBe("Invalid")
}).pipe(Effect.provide(ledgerProcess), Effect.scoped), ledgerTestTimeout)

it.effect("real Python ledger SDK uses the configured poll interval and stops reading when the stream is cancelled", () => Effect.gen(function*() {
  let reads = 0
  const client = yield* ConnectorTest.makeClient(make({ read: () => Effect.sync(() => {
    reads++
    return reads < 3 ? baseline : { ...baseline, generation: "2", snapshot: token(11), messages: [message, { ...message, id: token(8), reply: true }] }
  }) }))
  yield* client.Configure({ values: { privateSource, pollIntervalMs: "1000" } })
  const ready = yield* Deferred.make<void>()
  const fiber = yield* client.Watch({ parameters: { selection: "selected" }, eventTypes: [] }).pipe(
    Stream.tap((item) => item._tag === "Cursor" ? Deferred.succeed(ready, undefined) : Effect.void),
    Stream.take(2), Stream.runCollect, Effect.forkChild
  )
  yield* Deferred.await(ready)
  yield* TestClock.adjust("1 second")
  const items = yield* Fiber.join(fiber)
  expect(items.map((item) => item._tag)).toEqual(["Cursor", "Event"])
  expect(items[1]?._tag === "Event" && items[1].event.type).toBe("thread.reply")
  const stopped = reads
  yield* TestClock.adjust("1 minute")
  expect(reads).toBe(stopped)
}).pipe(Effect.provide(ledgerProcess), Effect.scoped), ledgerTestTimeout)

it.effect("real Python ledger SDK restarts with a persisted cursor and checkpoints a filtered batch", () => Effect.gen(function*() {
  const first = yield* ConnectorTest.makeClient(make({ read: () => Effect.succeed(baseline) }))
  yield* first.Configure({ values: { privateSource } })
  const items = yield* first.Watch({ parameters: { selection: "selected" }, eventTypes: [] }).pipe(Stream.take(1), Stream.runCollect)
  if (items[0]?._tag !== "Cursor") throw new Error("Expected baseline cursor")
  const changed = { ...baseline, generation: "2", snapshot: token(11), messages: [{ ...message, body: token(5), reactions: [] }] }
  const restarted = yield* ConnectorTest.makeClient(make({ read: () => Effect.succeed(changed) }))
  yield* restarted.Configure({ values: { privateSource } })
  const catalogue = (yield* restarted.Handshake()).catalogue
  const filtered = yield* restarted.Watch({ parameters: { selection: "selected" }, eventTypes: [catalogue.eventTypes[0]!.type], cursor: items[0].cursor }).pipe(Stream.take(1), Stream.runCollect)
  expect(filtered[0]?._tag).toBe("Cursor")
  expect(filtered[0]).not.toEqual(items[0])
}).pipe(Effect.provide(ledgerProcess), Effect.scoped), ledgerTestTimeout)

it.effect("real Python ledger SDK recovers every partial batch boundary after source turnover", () => Effect.gen(function*() {
  let current: typeof Snapshot.Type = baseline
  const client = yield* ConnectorTest.makeClient(make({ read: () => Effect.sync(() => current) }))
  yield* client.Configure({ values: { privateSource } })
  const watch = (cursor?: string) => client.Watch({ parameters: { selection: "selected" }, eventTypes: [], ...(cursor === undefined ? {} : { cursor }) })
  const initial = yield* watch().pipe(Stream.take(1), Stream.runCollect)
  if (initial[0]?._tag !== "Cursor") throw new Error("Expected baseline cursor")
  const saved = initial[0].cursor
  current = { ...baseline, generation: "2", snapshot: token(11), messages: [{ ...message, body: token(5), reactions: [] }, { ...message, id: token(8), reply: true }] }
  const committed = yield* watch(saved).pipe(Stream.take(3), Stream.runCollect)
  if (committed[2]?._tag !== "Event" || committed[2].cursor === undefined) throw new Error("Expected final cursor")
  const finalCursor = committed[2].cursor
  const keys = committed.map((item) => item._tag === "Event" && item.event.dedupeKey)
  expect(new Set(keys).size).toBe(3)
  current = { ...baseline, generation: "3", snapshot: token(12), messages: [{ ...message, body: token(6), reactions: [] }, { ...message, id: token(8), reply: true }] }
  for (let boundary = 1; boundary < committed.length; boundary++) {
    const partial = yield* watch(saved).pipe(Stream.take(boundary), Stream.runCollect)
    expect(partial.every((item) => !("cursor" in item))).toBe(true)
    yield* TestClock.adjust("1 minute")
    const restarted = yield* ConnectorTest.makeClient(make({ read: () => Effect.succeed(current) }))
    yield* restarted.Configure({ values: { privateSource } })
    const replay = yield* restarted.Watch({ parameters: { selection: "selected" }, eventTypes: [], cursor: saved }).pipe(Stream.take(3), Stream.runCollect)
    expect(replay.map((item) => item._tag === "Event" && item.event.dedupeKey)).toEqual(keys)
    expect(replay).toEqual(committed)
    expect(replay[2]).toMatchObject({ cursor: finalCursor })
  }
  expect(finalCursor).toBeDefined()
  const next = yield* watch(finalCursor).pipe(Stream.take(1), Stream.runCollect)
  expect(next[0]?._tag === "Event" && next[0].event.type).toBe("message.edited")
  expect(next[0]?._tag === "Event" && keys.includes(next[0].event.dedupeKey)).toBe(false)
  const fresh = yield* watch().pipe(Stream.take(1), Stream.runCollect)
  expect(fresh[0]?._tag).toBe("Cursor")
  expect(fresh[0]).not.toMatchObject({ cursor: saved })
}).pipe(Effect.provide(ledgerProcess), Effect.scoped), ledgerTestTimeout)
