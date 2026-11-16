import { ledgerProcess, ledgerTestTimeout } from "./LedgerProcess.ts"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { localSource } from "../src/Source.ts"
import { expect, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Layer, Sink, Stream } from "effect"
import { TestClock } from "effect/testing"
import { Ids } from "@exangelos/domain"
import { ConnectorTest } from "@exangelos/connector-sdk"
import { gap, reconcile } from "../src/Reconcile.ts"
import { make } from "../src/Teams.ts"

const token = (n: number) => n.toString(16).padStart(64, "0")
const scope = token(1)
const message = { id: token(2), body: token(3), parent: null, reaction: token(4), reactions: [] as ReadonlyArray<string> }
const snapshot = { scope, messages: [message] }

it.effect("configuration fields authorize setup and invalid inputs never access the source", () => Effect.gen(function*() {
  const setups: Array<unknown> = []
  let reads = 0
  const client = yield* ConnectorTest.makeClient(make({
    configure: (values) => Effect.sync(() => { setups.push(values); return snapshot }),
    read: Effect.sync(() => { reads++; return snapshot })
  }))
  const catalogue = (yield* client.Handshake()).catalogue
  expect(catalogue.configuration.map((field) => [field.key, field._tag, field.required]))
    .toEqual([["selectionToken", "Secret", true], ["cachePath", "Text", false]])
  expect((yield* client.Describe({ parameters: { selection: "selected" } }))._tag).toBe("Invalid")
  for (const values of [{}, { selectionToken: "short" }, { selectionToken: "synthetic-marker-123", cachePath: "relative" }]) {
    expect((yield* client.Configure({ values }))._tag).toBe("Rejected")
  }
  expect(setups).toEqual([])
  expect(reads).toBe(0)
  expect((yield* client.Configure({ values: { selectionToken: "synthetic-marker-123", cachePath: "/synthetic/custom-cache" } }))._tag).toBe("Accepted")
  expect(setups).toEqual([{ selectionToken: "synthetic-marker-123", cachePath: "/synthetic/custom-cache" }])
  expect(reads).toBe(0)
  expect((yield* client.Describe({ parameters: { selection: "selected" } }))._tag).toBe("Described")
}).pipe(Effect.provide(ledgerProcess), Effect.scoped))

it.effect("real Python ledger: silent baseline, durable resume, stable replay keys and distinct repeated transitions", () => Effect.gen(function*() {
  const baseline = yield* reconcile(scope, undefined, snapshot)
  expect(baseline.events).toEqual([])
  expect(baseline.cursor.length).toBeLessThan(512)
  const changed = { scope, messages: [{ ...message, body: token(5), reaction: token(6), reactions: [token(7)] }] }
  const first = yield* reconcile(scope, baseline.cursor, changed)
  expect(first.events.map((e) => e.type)).toEqual(["message.edited", "reaction.added"])
  expect(yield* reconcile(scope, baseline.cursor, changed)).toEqual(first)
  expect((yield* reconcile(scope, first.cursor, changed)).events).toEqual([])
  const reverted = yield* reconcile(scope, first.cursor, snapshot)
  const repeated = yield* reconcile(scope, reverted.cursor, changed)
  expect(repeated.events[0]?.dedupeKey).not.toEqual(first.events[0]?.dedupeKey)
}).pipe(Effect.provide(ledgerProcess)), ledgerTestTimeout)

it.effect("real Python ledger: missing candidates and unknown reactions never imply deletion or removal", () => Effect.gen(function*() {
  const other = { ...message, id: token(10) }
  const baseline = yield* reconcile(scope, undefined, { scope, messages: [message, other] })
  const missing = yield* reconcile(scope, baseline.cursor, { scope, messages: [{ ...other, reaction: null, reactions: null }] })
  expect(missing.events).toEqual([])
  const returned = yield* reconcile(scope, missing.cursor, { scope, messages: [message, other] })
  expect(returned.events).toEqual([])
}).pipe(Effect.provide(ledgerProcess)), ledgerTestTimeout)

it.effect("real Python ledger: fails closed on subject mismatch, bad resume, duplicate identities and empty acquisition", () => Effect.gen(function*() {
  const baseline = yield* reconcile(scope, undefined, snapshot)
  for (const input of [{ ...snapshot, scope: token(99) }, { scope, messages: [] },
    { scope, messages: [message, message] }, { scope, messages: [{ ...message, body: "private-content" }] }]) {
    const error = yield* reconcile(scope, baseline.cursor, input).pipe(Effect.flip)
    expect(error._tag).toBe("ObservationGap")
    expect(JSON.stringify(error)).not.toContain("private-content")
  }
  expect((yield* reconcile(scope, "broken-private-cursor", snapshot).pipe(Effect.flip))._tag).toBe("ObservationGap")
  expect((yield* reconcile(token(99), baseline.cursor, snapshot).pipe(Effect.flip))._tag).toBe("ObservationGap")
}).pipe(Effect.provide(ledgerProcess)), ledgerTestTimeout)

it.effect("real Python ledger: SDK names an opaque subject, starts silently, resumes a batch and filters with its cursor", () => Effect.gen(function*() {
  let current = snapshot
  const client = yield* ConnectorTest.makeClient(make({ read: Effect.sync(() => current) }))
  expect((yield* client.Handshake()).catalogue.eventTypes.map((e) => e.type)).toEqual([
    "message.new", "message.reply", "message.edited", "reaction.added", "reaction.removed"
  ])
  expect((yield* client.Configure({ values: { selectionToken: "synthetic-marker-123" } }))._tag).toBe("Accepted")
  expect(yield* client.Describe({ parameters: { selection: "selected" } })).toMatchObject({
    _tag: "Described", subject: `teams:${scope}`, parameters: { selection: scope }
  })
  const baseline = yield* client.Watch({ parameters: { selection: scope }, eventTypes: [] }).pipe(Stream.take(1), Stream.runCollect)
  expect(baseline[0]?._tag).toBe("Cursor")
  if (baseline[0]?._tag !== "Cursor") throw new Error("Expected baseline cursor")
  const cursor = baseline[0].cursor
  current = { scope, messages: [{ ...message, body: token(5), reaction: token(6), reactions: [token(7)] }] }
  const batch = yield* client.Watch({ parameters: { selection: scope }, eventTypes: [], cursor }).pipe(Stream.take(2), Stream.runCollect)
  expect(batch.map((i) => i._tag)).toEqual(["Event", "Event"])
  expect(batch[0]).not.toHaveProperty("cursor")
  expect(batch[1]).toHaveProperty("cursor")
  const partial = yield* client.Watch({ parameters: { selection: scope }, eventTypes: [], cursor }).pipe(Stream.take(1), Stream.runCollect)
  expect(partial).toEqual(batch.slice(0, 1))
  current = { scope, messages: [{ ...message, body: token(99), reaction: token(6), reactions: [] }] }
  yield* TestClock.adjust("1 minute")
  const restarted = yield* ConnectorTest.makeClient(make({ read: Effect.sync(() => current) }))
  yield* restarted.Configure({ values: { selectionToken: "synthetic-marker-123" } })
  const replay = yield* restarted.Watch({ parameters: { selection: scope }, eventTypes: [], cursor }).pipe(Stream.take(2), Stream.runCollect)
  expect(replay).toEqual(batch)
  const filtered = yield* client.Watch({ parameters: { selection: scope }, eventTypes: [Ids.EventType.make("message.new")], cursor }).pipe(Stream.take(1), Stream.runCollect)
  expect(filtered[0]?._tag).toBe("Cursor")
}).pipe(Effect.provide(ledgerProcess), Effect.scoped), ledgerTestTimeout)

it.effect("real Python ledger: SDK sanitizes acquisition failure and rejects a changed private selection", () => Effect.gen(function*() {
  let current = snapshot
  let failing = false
  const client = yield* ConnectorTest.makeClient(make({ read: Effect.suspend(() => failing ? Effect.fail(gap()) : Effect.succeed(current)) }))
  yield* client.Configure({ values: { selectionToken: "synthetic-marker-123" } })
  current = { ...snapshot, scope: token(20) }
  const error = yield* client.Watch({ parameters: { selection: scope }, eventTypes: [] }).pipe(Stream.runCollect, Effect.flip)
  expect(error._tag).toBe("SourceFailed")
  failing = true
  expect((yield* client.Configure({ values: { selectionToken: "synthetic-marker-123" } }))._tag).toBe("Rejected")
  expect((yield* client.Describe({ parameters: { selection: "selected" } }))._tag).toBe("Invalid")
}).pipe(Effect.provide(ledgerProcess), Effect.scoped))

it.effect("real Python ledger: polls after the wake delay and cancels with the SDK stream", () => Effect.gen(function*() {
  let reads = 0
  const client = yield* ConnectorTest.makeClient(make({ read: Effect.sync(() => {
    reads++
    return reads < 3 ? snapshot : { scope, messages: [message, { ...message, id: token(30), parent: message.id }] }
  }) }))
  yield* client.Configure({ values: { selectionToken: "synthetic-marker-123" } })
  const ready = yield* Deferred.make<void>()
  const fiber = yield* client.Watch({ parameters: { selection: scope }, eventTypes: [] }).pipe(
    Stream.tap((item) => item._tag === "Cursor" ? Deferred.succeed(ready, undefined) : Effect.void),
    Stream.take(2), Stream.runCollect, Effect.forkChild
  )
  yield* Deferred.await(ready)
  yield* TestClock.adjust("5 seconds")
  const items = yield* Fiber.join(fiber)
  expect(items.map((i) => i._tag)).toEqual(["Cursor", "Event"])
  expect(items[1]?._tag === "Event" && items[1].event.type).toBe("message.reply")
  const stopped = reads
  yield* TestClock.adjust("1 minute")
  expect(reads).toBe(stopped)
}).pipe(Effect.provide(ledgerProcess), Effect.scoped), ledgerTestTimeout)

it.effect("real Python ledger: local source feeds Configure and Watch through the process service", () => Effect.gen(function*() {
  let calls = 0
  const real = yield* ChildProcessSpawner.ChildProcessSpawner
  const spawner = ChildProcessSpawner.make((command) => {
    const standard = command as ChildProcess.StandardCommand
    if (typeof standard.args[0] === "string" && standard.args[0].endsWith("/runtime/ledger.py")) return real.spawn(command)
    return Effect.gen(function*() {
      const standard = command as ChildProcess.StandardCommand
      expect(standard.command).toBe("python3")
      expect(standard.args[1]).toBe(calls === 0 ? "configure" : "configured-snapshot")
      expect(standard.args).not.toContain("synthetic-marker-123")
      if (calls === 0) {
        const input = standard.options.stdin
        if (typeof input !== "object" || input === null || !("stream" in input) || !Stream.isStream(input.stream)) throw new Error("Expected private setup stdin")
        const chunks = yield* input.stream.pipe(Stream.runCollect)
        expect(JSON.parse(new TextDecoder().decode(Buffer.concat(chunks))))
          .toEqual({ selectionToken: "synthetic-marker-123" })
      } else {
        expect(standard.options.stdin).toBe("ignore")
      }
      calls++
      const current = calls < 3 ? snapshot : { scope, messages: [{ ...message, body: token(42) }] }
      const stdout = Stream.make(new TextEncoder().encode(JSON.stringify(current)))
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1), exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
        isRunning: Effect.succeed(false), kill: () => Effect.void, stdin: Sink.drain,
        stdout, stderr: Stream.empty, all: stdout, getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty, unref: Effect.succeed(Effect.void)
      })
    })
  })
  yield* Effect.gen(function*() {
    const client = yield* ConnectorTest.makeClient(make(localSource))
    yield* client.Configure({ values: { selectionToken: "synthetic-marker-123" } })
    const ready = yield* Deferred.make<void>()
    const fiber = yield* client.Watch({ parameters: { selection: scope }, eventTypes: [] }).pipe(
      Stream.tap((item) => item._tag === "Cursor" ? Deferred.succeed(ready, undefined) : Effect.void),
      Stream.take(2), Stream.runCollect, Effect.forkChild)
    yield* Deferred.await(ready)
    yield* TestClock.adjust("5 seconds")
    const items = yield* Fiber.join(fiber)
    expect(items.map((i) => i._tag)).toEqual(["Cursor", "Event"])
    expect(items[1]?._tag === "Event" && items[1].event.type).toBe("message.edited")
  }).pipe(Effect.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)))
}).pipe(Effect.provide(ledgerProcess), Effect.scoped), ledgerTestTimeout)

it.effect("real Python ledger: process failures and oversized output remain sanitized observation gaps", () => Effect.gen(function*() {
  for (const [code, text] of [[1, "synthetic private diagnostic"], [0, "x".repeat(300001)]] as const) {
    const output = Stream.make(new TextEncoder().encode(text))
    const layer = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, ChildProcessSpawner.make(() =>
      Effect.succeed(ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1), exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(code)),
        isRunning: Effect.succeed(false), kill: () => Effect.void, stdin: Sink.drain,
        stdout: output, stderr: Stream.empty, all: output, getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty, unref: Effect.succeed(Effect.void)
      }))))
    const error = yield* localSource.read.pipe(Effect.provide(layer), Effect.flip)
    expect(error._tag).toBe("ObservationGap")
    expect(JSON.stringify(error)).not.toContain(text)
  }
}).pipe(Effect.provide(ledgerProcess)))

it.effect("real Python ledger: new roots and replies have distinct event types", () => Effect.gen(function*() {
  const baseline = yield* reconcile(scope, undefined, snapshot)
  const next = yield* reconcile(scope, baseline.cursor, { scope, messages: [message,
    { ...message, id: token(20) }, { ...message, id: token(21), parent: message.id }] })
  expect(next.events.map((event) => event.type)).toEqual(["message.new", "message.reply"])
}).pipe(Effect.provide(ledgerProcess)), ledgerTestTimeout)

it.effect("real Python ledger: membership order and aggregate fingerprint changes do not emit reactions", () => Effect.gen(function*() {
  const baseline = yield* reconcile(scope, undefined, { scope,
    messages: [{ ...message, reactions: [token(8), token(7)] }] })
  const reordered = yield* reconcile(scope, baseline.cursor, { scope,
    messages: [{ ...message, reaction: token(90), reactions: [token(7), token(8)] }] })
  expect(reordered.events).toEqual([])
  const changed = { scope, messages: [{ ...message, reactions: [token(9)] }] }
  expect((yield* reconcile(scope, reordered.cursor, changed)).events.map((e) => e.type))
    .toEqual(["reaction.added", "reaction.removed", "reaction.removed"])
}).pipe(Effect.provide(ledgerProcess)), ledgerTestTimeout)

it.effect("real Python ledger: same member add, remove and readd have distinct keys and stable replays", () => Effect.gen(function*() {
  const baseline = yield* reconcile(scope, undefined, snapshot)
  const addedSnapshot = { scope, messages: [{ ...message, reactions: [token(7)] }] }
  const added = yield* reconcile(scope, baseline.cursor, addedSnapshot)
  const removed = yield* reconcile(scope, added.cursor, snapshot)
  const readded = yield* reconcile(scope, removed.cursor, addedSnapshot)
  expect([added, removed, readded].map((r) => r.events.map((e) => e.type)))
    .toEqual([["reaction.added"], ["reaction.removed"], ["reaction.added"]])
  expect(new Set([added, removed, readded].map((r) => r.events[0]?.dedupeKey)).size).toBe(3)
  expect(yield* reconcile(scope, removed.cursor, addedSnapshot)).toEqual(readded)
}).pipe(Effect.provide(ledgerProcess)), ledgerTestTimeout)

it.effect("real Python ledger: unknown membership breaks continuity in both directions", () => Effect.gen(function*() {
  for (const initial of [[], [token(7)]]) {
    const baseline = yield* reconcile(scope, undefined, { scope,
      messages: [{ ...message, reactions: initial }] })
    const unknown = yield* reconcile(scope, baseline.cursor, { scope,
      messages: [{ ...message, reactions: null }] })
    expect(unknown.events).toEqual([])
    const restored = yield* reconcile(scope, unknown.cursor, { scope,
      messages: [{ ...message, reactions: initial.length ? [] : [token(7)] }] })
    expect(restored.events).toEqual([])
    const continued = yield* reconcile(scope, restored.cursor, { scope,
      messages: [{ ...message, reactions: initial }] })
    expect(continued.events.map((e) => e.type)).toEqual([initial.length ? "reaction.added" : "reaction.removed"])
  }
}).pipe(Effect.provide(ledgerProcess)), ledgerTestTimeout)

it.effect("real Python ledger: rejects duplicate memberships, malformed members and obsolete cursors", () => Effect.gen(function*() {
  const baseline = yield* reconcile(scope, undefined, snapshot)
  for (const reactions of [[token(7), token(7)], ["synthetic-invalid"], [null], Array.from({ length: 501 }, (_, i) => token(i))]) {
    const input = { scope, messages: [{ ...message, reactions }] }
    expect((yield* reconcile(scope, baseline.cursor, input).pipe(Effect.flip))._tag).toBe("ObservationGap")
  }
  for (const cursor of [
    { version: 1 },
    { version: 2, scope, messages: [{ ...message, reactions: [token(7), token(7)], revision: 0 }] }
  ]) {
    expect((yield* reconcile(scope, JSON.stringify(cursor), snapshot).pipe(Effect.flip))._tag).toBe("ObservationGap")
  }
}).pipe(Effect.provide(ledgerProcess)), ledgerTestTimeout)

it.effect("real Python ledger: large metadata baselines retain a bounded opaque cursor", () => Effect.gen(function*() {
  const messages = Array.from({ length: 500 }, (_, i) => ({ ...message, id: token(i + 100),
    reactions: Array.from({ length: 40 }, (_, j) => token(j + 1000)) }))
  expect((yield* reconcile(scope, undefined, { scope, messages })).cursor.length).toBeLessThan(512)
}).pipe(Effect.provide(ledgerProcess)), ledgerTestTimeout)
