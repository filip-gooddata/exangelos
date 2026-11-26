import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { appendFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { deliver as deliverToAgent } from "./InstalledWake.ts"
import { digestDirectory } from "../../../adapters/connector-directory/src/Digest.ts"
import type { Event } from "../../../packages/domain/src/index.ts"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, Fiber, Layer, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { ConnectorRuntime } from "../../../packages/application/src/index.ts"
import { StdioConnectorRuntime } from "../../../adapters/connector-runtime/src/index.ts"

const installed = realpathSync(process.argv[2]!)
const evidence = resolve(process.argv[3]!)
const python = process.argv[4]!
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "teams-installed-cases-")))
const fixture = resolve(import.meta.dirname, "../scripts/release-fixture.py")
const inventory = () => {
  const walk = (directory: string): Array<unknown> => readdirSync(directory).sort().flatMap((name) => {
    const path = join(directory, name)
    const stat = lstatSync(path)
    assert(!stat.isSymbolicLink())
    return [{ path: path.slice(installed.length + 1), mode: stat.mode, size: stat.size,
      mtime: stat.mtimeMs, ctime: stat.ctimeMs,
      hash: stat.isFile() ? createHash("sha256").update(readFileSync(path)).digest("hex") : null },
    ...(stat.isDirectory() ? walk(path) : [])]
  })
  const root = lstatSync(installed)
  return [{ path: "", mode: root.mode, size: root.size, mtime: root.mtimeMs, ctime: root.ctimeMs }, ...walk(installed)]
}
const before = inventory()
writeFileSync(join(evidence, "installed-before.json"), JSON.stringify(before, null, 2))
const unchanged = (label: string) => {
  const after = inventory()
  writeFileSync(join(evidence, `installed-${label}.json`), JSON.stringify(after, null, 2))
  assert.deepEqual(after, before)
}
const baseEnv = {
  HOME: scratch, TMPDIR: scratch, PATH: `${resolve(python, "..")}:/usr/bin:/bin`,
  EXANGELOS_HOME: join(scratch, "home"), XDG_DATA_HOME: join(scratch, "xdg"),
  XDG_CONFIG_HOME: join(scratch, "config"), XDG_CACHE_HOME: join(scratch, "cache"), EXANGELOS_TEAMS_CONFIG: join(scratch, "missing.json"),
  EXANGELOS_TEAMS_CACHE: join(scratch, "missing-cache"), EXAMPLE_TOKEN: "synthetic-secret-token"
}
const launch = Schema.decodeSync(ConnectorRuntime.Launch)({
  name: "teams", directory: installed, entry: { _tag: "Bundle", path: "dist/main.js" }, dev: false
})
const request = (selection: string, cursor?: string) => Schema.decodeSync(ConnectorRuntime.WatchRequest)({
  parameters: { selection }, eventTypes: [], wakeWindow: 1000, ...(cursor === undefined ? {} : { cursor })
})
const run = async (label: string, env: Record<string, string>, test: (connector: ConnectorRuntime.ConnectorProcess) => Effect.Effect<void, unknown, import("effect").Scope.Scope>) => {
  let stderr = ""
  const spawner = Layer.effect(ChildProcessSpawner.ChildProcessSpawner, Effect.gen(function*() {
    const real = yield* ChildProcessSpawner.ChildProcessSpawner
    return ChildProcessSpawner.make((command) => Effect.gen(function*() {
      const standard = command as ChildProcess.StandardCommand
      assert.equal(standard.options.cwd, installed)
      const child = yield* real.spawn(ChildProcess.make(standard.command, standard.args, {
        ...standard.options, env: { ...env, BUN_BE_BUN: "1" }, extendEnv: false, stderr: "pipe"
      }))
      yield* child.stderr.pipe(Stream.runForEach((chunk) => Effect.sync(() => { stderr += new TextDecoder().decode(chunk) })), Effect.forkScoped)
      return child
    }))
  })).pipe(Layer.provide(BunServices.layer))
  await Effect.gen(function*() {
    const runtime = yield* ConnectorRuntime.ConnectorRuntime
    const connector = yield* runtime.start(launch)
    assert.equal(connector.catalogue.eventTypes.length, 5)
    yield* test(connector)
  }).pipe(Effect.scoped, Effect.provide(StdioConnectorRuntime.layer().pipe(Layer.provide(spawner))),
    Effect.timeout("25 seconds"), Effect.runPromise)
  assert.equal(stderr, "")
  unchanged(label)
  console.log(`PASS ${label}`)
}
const account = "11111111-1111-4111-8111-111111111111"
const tenant = "22222222-2222-4222-8222-222222222222"
const groupId = "33333333-3333-4333-8333-333333333333"
const channel = "19:syntheticchannel@thread.tacv2"
const chat = "19:syntheticchat@thread.v2"
const label = "Synthetic channel"
const excerpt = `Review password and token rotation, ID 6f1d8b42-9c73-4a15-b0e6-2d8c7f4a1e93. "hello" and ${baseEnv.EXAMPLE_TOKEN}.`
const safeExcerpt = excerpt.replace(baseEnv.EXAMPLE_TOKEN, "[redacted]")
const cache = join(scratch, "custom directory", "cache")
const deliver = (directory: string, subject: string, event: Event.ReportedEvent) => Effect.gen(function*() {
  const text = yield* deliverToAgent(directory, subject, event)
  appendFileSync(join(evidence, "rendered-wakes.jsonl"), JSON.stringify({ type: event.type, text }) + "\n")
  return text
})
const message = (id: string, conversationId: string, timestamp: string, parent?: string) => ({
  id, conversationId, originalArrivalTime: timestamp, imDisplayName: "Synthetic Avery", content: excerpt + (parent ? " reply" : " top"),
  tenantId: tenant, groupId, properties: { emotions: [] as { key: string, users: { mri: string }[] }[] }, ...(parent && { parentMessageId: parent })
})
const old = "2020-01-01T00:00:00.000Z"
const root = "1577836800000"
const rows = [message(root, channel, old), message("1577836800001", chat, old)]
const generate = (path = cache, owner = account) => execFileSync(python, [fixture, path], {
  input: JSON.stringify({ account: owner, tenant, rows, conversations: [
    { id: channel, chatTitle: { shortTitle: label }, threadProperties: { topic: label, groupId }, groupId, tenantId: tenant },
    { id: chat, chatTitle: { shortTitle: "Synthetic chat" } }
  ] }), timeout: 10000, stdio: "pipe", env: { HOME: scratch, PATH: baseEnv.PATH }
})
type Connector = ConnectorRuntime.ConnectorProcess
const consent = (connector: Connector, previews = false, path = cache) => Effect.gen(function*() {
  assert.deepEqual(yield* connector.configure({ subscriptionAccess: "persisted-cache", cachePath: path,
    messagePreviews: previews ? "enabled" : "disabled" }), { _tag: "Accepted" })
})
const describe = (connector: Connector, selection: string, scope?: string) => Effect.gen(function*() {
  const result = yield* connector.describe({ selection, ...(scope && { scope }) })
  assert(result._tag === "Described", JSON.stringify(result))
  const pin = result.parameters.selection
  assert(typeof pin === "string")
  assert.match(pin, /^scope-[0-9a-f]{64}$/)
  return { pin, subject: result.subject, label: result.label }
})
const take = (connector: Connector, selection: string, cursor?: string, count = 1) =>
  connector.watch(request(selection, cursor)).pipe(Stream.take(count), Stream.runCollect)
const baseline = (connector: Connector, selection: string) => Effect.gen(function*() {
  const [item] = yield* take(connector, selection)
  assert(item?._tag === "Cursor")
  return item.cursor
})
const quiet = (connector: Connector, selection: string, cursor: string) => Effect.gen(function*() {
  const items: Event.WatchItem[] = []
  const fiber = yield* connector.watch(request(selection, cursor)).pipe(
    Stream.tap((item) => Effect.sync(() => { items.push(item) })), Stream.runDrain, Effect.forkChild)
  yield* Effect.sleep("2200 millis")
  assert.equal(fiber.pollUnsafe(), undefined)
  assert.deepEqual(items, [{ _tag: "Cursor", cursor }])
  yield* Fiber.interrupt(fiber)
})
try {
  assert.equal(await Effect.runPromise(digestDirectory(installed)), process.argv[5])
  const shim = join(scratch, "shim")
  mkdirSync(shim)
  writeFileSync(join(shim, "python3"), '#!/bin/sh\n/usr/bin/touch "$HOME/python-invoked"\nexit 1\n', { mode: 0o700 })
  const fifo = join(scratch, "cache-sentinel")
  execFileSync("/usr/bin/mkfifo", [fifo])
  const stat = lstatSync(fifo)
  await run("preconsent", { ...baseEnv, PATH: shim, EXANGELOS_TEAMS_CACHE: fifo, EXANGELOS_TEAMS_CONFIG: fifo }, (c) => Effect.gen(function*() {
    assert.equal((yield* c.describe({ selection: channel }))._tag, "Invalid")
    assert.equal((yield* c.configure({ selectionToken: "retired" }))._tag, "Rejected")
    yield* c.watch(request(channel)).pipe(Stream.runDrain, Effect.flip)
    yield* consent(c, false, fifo)
    yield* Effect.sleep("1200 millis")
  }))
  assert(!existsSync(join(scratch, "python-invoked")))
  assert.deepEqual(lstatSync(fifo), stat)
  generate()
  const url = `https://teams.microsoft.com/l/message/${encodeURIComponent(channel)}/${root}`
  const legacyDir = join(baseEnv.EXANGELOS_HOME, "connectors/teams")
  mkdirSync(legacyDir, { recursive: true, mode: 0o700 })
  const legacy = join(legacyDir, "selection.json")
  const oldState = JSON.stringify({ scope: "a".repeat(64), key: "b".repeat(64), cache })
  writeFileSync(legacy, oldState, { mode: 0o600 })
  let conversation = "", replies = "", dm = "", subject = ""
  let channelCursor = "", replyCursor = "", previewCursor = "", dmCursor = ""
  await run("bind-and-baseline", baseEnv, (c) => Effect.gen(function*() {
    yield* consent(c)
    for (const selection of ["selected", "a".repeat(64)]) {
      assert.equal((yield* c.describe({ selection }))._tag, "Invalid")
      yield* c.watch(request(selection)).pipe(Stream.runDrain, Effect.flip)
    }
    assert.equal((yield* c.describe({ selection: url }))._tag, "Invalid")
    const bound = yield* describe(c, channel)
    conversation = bound.pin
    subject = bound.subject
    assert(bound.label.includes(label))
    assert.equal((yield* describe(c, url, "conversation")).pin, conversation)
    replies = (yield* describe(c, url, "replies")).pin
    dm = (yield* describe(c, chat)).pin
    assert.equal(new Set([dm, replies, conversation]).size, 3)
    channelCursor = yield* baseline(c, conversation)
    replyCursor = yield* baseline(c, replies)
    dmCursor = yield* baseline(c, dm)
    yield* consent(c, true)
    previewCursor = yield* baseline(c, conversation)
  }))
  assert.equal(readFileSync(legacy, "utf8"), oldState)
  const legacyEnv = { ...baseEnv, EXANGELOS_HOME: join(scratch, "legacy-root") }
  const legacyState = join(legacyEnv.EXANGELOS_HOME, "connectors/teams")
  mkdirSync(legacyState, { mode: 0o700, recursive: true })
  cpSync(join(baseEnv.EXANGELOS_HOME, "connector-state/teams"), legacyState, { recursive: true })
  await run("legacy-source-failure", { ...legacyEnv, PATH: join(scratch, "empty-path") }, c => Effect.gen(function*() {
    yield* consent(c)
    yield* take(c, conversation, channelCursor).pipe(Effect.flip)
  }))
  const diagnostic = join(legacyEnv.EXANGELOS_HOME, "diagnostics/teams/last-error.json")
  const retained = readFileSync(diagnostic, "utf8")
  assert.equal(JSON.parse(retained).errno, "ENOENT")
  assert(!existsSync(join(legacyEnv.EXANGELOS_HOME, "connector-state/teams")))
  await run("legacy-cursor-recovery", legacyEnv, c => Effect.gen(function*() {
    yield* consent(c)
    assert.deepEqual(yield* take(c, conversation, channelCursor), [{ _tag: "Cursor", cursor: channelCursor }])
  }))
  assert.equal(readFileSync(diagnostic, "utf8"), retained)
  const now = Date.now()
  const first = String(now), reply = String(now + 1)
  const fresh = new Date(now).toISOString()
  rows.push(message(first, channel, fresh), message(reply, channel, fresh, root),
    message("1577836800002", channel, old))
  generate()
  let replay: ReadonlyArray<Event.WatchItem> = []
  let next = ""
  await run("context-and-scopes", baseEnv, (c) => Effect.gen(function*() {
    yield* consent(c)
    replay = yield* take(c, conversation, channelCursor, 2)
    const seen: string[] = []
    for (const item of replay) {
      assert(item._tag === "Event")
      const event = item.event
      const id = event.type === "message.reply" ? reply : first
      seen.push(event.type)
      const payload = event.payload as Record<string, unknown>
      assert.equal(payload.sender, "Synthetic Avery")
      assert(String(payload.conversationLabel).includes(label))
      assert.equal(payload.messageTime, now)
      assert.equal(payload.preview, undefined)
      assert.equal(typeof payload.permalink, "string")
      const link = new URL(String(payload.permalink))
      assert.equal(link.origin, "https://teams.microsoft.com")
      assert.equal(decodeURIComponent(link.pathname), `/l/message/${channel}/${id}`)
      const wake = yield* deliver(scratch, subject, event)
      assert(wake.includes("Synthetic Avery") && wake.includes(label) && wake.includes(fresh))
      assert.equal(link.searchParams.get("tenantId"), tenant)
      assert.equal(link.searchParams.get("groupId"), groupId)
      assert.equal(link.searchParams.get("parentMessageId"), id === reply ? root : first)
      assert(wake.includes(link.href))
      assert(!wake.includes(excerpt))
      assert(!wake.includes("password") && !wake.includes("token") && !wake.includes("6f1d8b42"))
    }
    assert.deepEqual(seen.sort(), ["message.new", "message.reply"])
    const last = replay.at(-1)
    assert(last?._tag === "Event" && last.cursor)
    next = last.cursor
    const [only] = yield* take(c, replies, replyCursor)
    assert(only?._tag === "Event" && only.event.type === "message.reply" && only.cursor)
    yield* quiet(c, replies, only.cursor)
    yield* quiet(c, dm, dmCursor)
  }))
  await run("replay-and-preview", baseEnv, (c) => Effect.gen(function*() {
    yield* consent(c)
    assert.deepEqual(yield* take(c, conversation, channelCursor, 2), replay)
    yield* quiet(c, conversation, next)
    yield* consent(c, true)
    const batch = yield* take(c, conversation, previewCursor, 2)
    for (const item of batch) {
      assert(item._tag === "Event")
      const preview = (item.event.payload as { preview: string }).preview
      const expected = safeExcerpt + (item.event.type === "message.reply" ? " reply" : " top")
      assert.equal(preview, expected)
      const wake = yield* deliver(scratch, subject, item.event)
      assert(wake.includes(`Untrusted message excerpt: ${JSON.stringify(preview)}`))
      assert(!wake.includes("synthetic-secret-token"))
    }
    assert.deepEqual(yield* take(c, conversation, previewCursor, 2), batch)
    yield* consent(c)
    yield* c.watch(request(conversation, previewCursor)).pipe(Stream.runDrain, Effect.flip)
  }))
  rows[0]!.content = "Updated fixture message"
  rows[0]!.properties.emotions.push({ key: "like", users: [{ mri: "synthetic-reactor" }] })
  generate()
  await run("edit-and-reactions", baseEnv, (c) => Effect.gen(function*() {
    yield* consent(c)
    const changes = yield* take(c, conversation, next, 2)
    const types: string[] = []
    for (const change of changes) {
      assert(change._tag === "Event")
      types.push(change.event.type)
      const wake = yield* deliver(scratch, subject, change.event)
      assert(wake.includes("actor unknown") && wake.includes("Synthetic Avery"))
      assert(!wake.includes("Updated fixture message"))
    }
    assert.deepEqual(types.sort(), ["message.edited", "reaction.added"])
    const last = changes.at(-1)
    assert(last?._tag === "Event" && last.cursor)
    rows[0]!.properties.emotions = []
    generate()
    const [removed] = yield* take(c, conversation, last.cursor)
    assert(removed?._tag === "Event" && removed.event.type === "reaction.removed")
    assert((yield* deliver(scratch, subject, removed.event)).includes("actor unknown"))
  }))
  const moved = join(scratch, "other user", "different cache")
  generate(moved, "44444444-4444-4444-8444-444444444444")
  await run("same-home-switch", baseEnv, (c) => Effect.gen(function*() {
    yield* consent(c, false, moved)
    assert.equal((yield* c.describe({ selection: conversation }))._tag, "Invalid")
    yield* c.watch(request(conversation, channelCursor)).pipe(Stream.runDrain, Effect.flip)
  }))
  await run("installed-state-rejected", { ...baseEnv, EXANGELOS_HOME: installed }, (c) => Effect.gen(function*() {
    yield* consent(c)
    assert.equal((yield* c.describe({ selection: channel }))._tag, "Invalid")
  }))
  await run("missing-python", { ...baseEnv, PATH: join(scratch, "empty-path") }, (c) => Effect.gen(function*() {
    yield* consent(c)
    assert.equal((yield* c.describe({ selection: channel }))._tag, "Invalid")
  }))
  const lastError = join(baseEnv.EXANGELOS_HOME, "diagnostics/teams/last-error.json")
  const spawnFailure = JSON.parse(readFileSync(lastError, "utf8"))
  assert.equal(spawnFailure.stage, "spawn")
  assert.equal(spawnFailure.errno, "ENOENT")
  assert.equal(lstatSync(lastError).mode & 0o777, 0o600)
  await run("portable-and-stale-pin", { ...baseEnv, HOME: join(scratch, "other user"), EXANGELOS_HOME: join(scratch, "other state") }, (c) => Effect.gen(function*() {
    yield* consent(c, false, moved)
    assert.equal((yield* c.describe({ selection: conversation }))._tag, "Invalid")
    const alternate = yield* describe(c, channel)
    assert.notEqual(alternate.pin, conversation)
    yield* baseline(c, alternate.pin)
    yield* c.watch(request(conversation, channelCursor)).pipe(Stream.runDrain, Effect.flip)
  }))
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
