import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
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
const reason = "Teams private selection is unavailable or does not match this subscription"
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
  EXANGELOS_TEAMS_CACHE: join(scratch, "missing-cache")
}
const values = { selectionToken: "synthetic-marker-123", cachePath: join(scratch, "private/cache") }
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
const preconfig = (connector: ConnectorRuntime.ConnectorProcess) => Effect.gen(function*() {
  assert.deepEqual(yield* connector.describe({ selection: "selected" }), { _tag: "Invalid", reason })
  yield* Effect.sleep("1200 millis")
  assert.equal((yield* connector.describe({ selection: "selected" }))._tag, "Invalid")
})
const generate = (version: string) => execFileSync(python, [fixture, join(scratch, "private"), version], { timeout: 10000, stdio: "pipe", env: { PATH: baseEnv.PATH } })
try {
  assert(existsSync(join(installed, "runtime/bridge.py")))
  assert(existsSync(join(installed, "validation/action_probe.py")))
  assert(!existsSync(join(installed, "test")))
  const shim = join(scratch, "shim")
  mkdirSync(shim)
  const marker = join(scratch, "python-invoked")
  writeFileSync(join(shim, "python3"), `#!/bin/sh\nprintf invoked > '${marker}'\nexit 1\n`, { mode: 0o700 })
  const sentinel = join(scratch, "sentinel")
  mkdirSync(sentinel, { mode: 0o700 })
  execFileSync("/usr/bin/mkfifo", [join(sentinel, "config"), join(sentinel, "cache")], { timeout: 5000 })
  const sentinelBefore = ["config", "cache"].map((name) => lstatSync(join(sentinel, name)))
  await run("preconfiguration-sentinels", { ...baseEnv, PATH: shim,
    EXANGELOS_TEAMS_CONFIG: join(sentinel, "config"), EXANGELOS_TEAMS_CACHE: join(sentinel, "cache") }, (connector) => Effect.gen(function*() {
    yield* preconfig(connector)
    assert.equal((yield* connector.configure({}))._tag, "Rejected")
  }))
  assert(!existsSync(marker))
  assert.deepEqual(["config", "cache"].map((name) => lstatSync(join(sentinel, name))), sentinelBefore)
  writeFileSync(join(evidence, "sentinels.json"), JSON.stringify({ pythonInvoked: false, fifoMetadataUnchanged: true }))
  await run("missing-config-cache", baseEnv, (connector) => Effect.gen(function*() {
    yield* preconfig(connector)
    assert.deepEqual(yield* connector.configure(values), { _tag: "Rejected", reason })
    yield* preconfig(connector)
  }))
  generate("baseline")
  const configured = { ...baseEnv, EXANGELOS_TEAMS_CONFIG: join(scratch, "private/config.json"), EXANGELOS_TEAMS_CACHE: join(scratch, "private/cache") }
  renameSync(join(scratch, "private/cache"), join(scratch, "private/cache-away"))
  await run("missing-cache", configured, (connector) => Effect.gen(function*() {
    yield* preconfig(connector)
    assert.deepEqual(yield* connector.configure(values), { _tag: "Rejected", reason })
    yield* preconfig(connector)
  }))
  renameSync(join(scratch, "private/cache-away"), join(scratch, "private/cache"))
  await run("missing-python", { ...configured, PATH: join(scratch, "absent") }, (connector) => Effect.gen(function*() {
    yield* preconfig(connector)
    assert.deepEqual(yield* connector.configure(values), { _tag: "Rejected", reason })
    yield* preconfig(connector)
  }))
  let cursor: string | undefined
  let changed: unknown
  let selection = ""
  await run("configured-change", configured, (connector) => Effect.gen(function*() {
    yield* preconfig(connector)
    assert.deepEqual(yield* connector.configure(values), { _tag: "Accepted" })
    const described = yield* connector.describe({ selection: "selected" })
    assert.equal(described._tag, "Described")
    if (described._tag !== "Described") throw new Error("Describe failed")
    selection = String(described.parameters.selection)
    const baseline = yield* connector.watch(request(selection)).pipe(Stream.take(1), Stream.runCollect)
    assert.equal(baseline[0]?._tag, "Cursor")
    if (baseline[0]?._tag !== "Cursor") throw new Error("Baseline failed")
    cursor = baseline[0].cursor
    const observed: Array<string> = []
    const idle = yield* connector.watch(request(selection, cursor)).pipe(Stream.tap((item) => Effect.sync(() => { observed.push(item._tag) })), Stream.runDrain, Effect.forkChild)
    yield* Effect.sleep("2200 millis")
    assert.equal(idle.pollUnsafe(), undefined)
    assert.equal(observed.length, 0)
    yield* Fiber.interrupt(idle)
    generate("changed")
    const events = yield* connector.watch(request(selection, cursor)).pipe(Stream.take(1), Stream.runCollect)
    assert.equal(events[0]?._tag, "Event")
    if (events[0]?._tag !== "Event") throw new Error("Change failed")
    assert.equal(events[0].event.type, "message.edited")
    assert.deepEqual(events[0].event.payload, { count: 1, source: "native-cache" })
    assert(events[0].cursor)
    changed = events[0]
  }))
  await run("durable-restart-replay", configured, (connector) => Effect.gen(function*() {
    assert.deepEqual(yield* connector.configure(values), { _tag: "Accepted" })
    const events = yield* connector.watch(request(selection, cursor)).pipe(Stream.take(1), Stream.runCollect)
    assert.deepEqual(events[0], changed)
    const next = events[0]
    assert(next?._tag === "Event" && next.cursor)
    const observed: Array<string> = []
    const idle = yield* connector.watch(request(selection, next.cursor)).pipe(Stream.tap((item) => Effect.sync(() => { observed.push(item._tag) })), Stream.runDrain, Effect.forkChild)
    yield* Effect.sleep("2200 millis")
    assert.equal(idle.pollUnsafe(), undefined)
    assert.equal(observed.length, 0)
    yield* Fiber.interrupt(idle)
  }))
  await run("installed-state-rejected", { ...configured, EXANGELOS_HOME: installed }, (connector) => Effect.gen(function*() {
    assert.deepEqual(yield* connector.configure(values), { _tag: "Rejected", reason })
  }))
  for (const [user, conversation] of [["user-red-renamed", "account-red-chat"], ["user-blue-moved", "account-blue-chat"]]) {
    const home = join(scratch, user!)
    mkdirSync(home, { mode: 0o700 })
    const privateRoot = join(home, "custom-app-data")
    execFileSync(python, [fixture, privateRoot, "baseline", conversation!], {
      timeout: 10000, stdio: "pipe", env: { HOME: home, PATH: baseEnv.PATH, PYTHONDONTWRITEBYTECODE: "1" }
    })
    const external = join(home, "external-state")
    await run(`portable-${user}`, { ...baseEnv, HOME: home, EXANGELOS_HOME: external,
      XDG_DATA_HOME: join(home, "xdg"), XDG_CONFIG_HOME: join(home, "config"), XDG_CACHE_HOME: join(home, "cache") },
    (connector) => Effect.gen(function*() {
      yield* preconfig(connector)
      assert.equal((yield* connector.configure({}))._tag, "Rejected")
      assert(!existsSync(external))
      assert.deepEqual(yield* connector.configure({ ...values, cachePath: join(privateRoot, "cache") }), { _tag: "Accepted" })
      const stateText = readFileSync(join(external, "connectors/teams/selection.json"), "utf8")
      const state = JSON.parse(stateText)
      assert.deepEqual(Object.keys(state).sort(), ["cache", "key", "scope"])
      assert.equal(state.cache, join(privateRoot, "cache"))
      assert(!stateText.includes(values.selectionToken))
      assert.notEqual(state.scope, selection)
      const described = yield* connector.describe({ selection: "selected" })
      assert.equal(described._tag, "Described")
      if (described._tag !== "Described") throw new Error("Describe failed")
      assert.equal(described.parameters.selection, state.scope)
      const baseline = yield* connector.watch(request(state.scope)).pipe(Stream.take(1), Stream.runCollect)
      assert.equal(baseline[0]?._tag, "Cursor")
      const wrong = yield* connector.watch(request(selection, cursor)).pipe(Stream.runCollect, Effect.flip)
      assert.equal(wrong._tag, "SourceFailed")
    }))
  }
  assert.equal(lstatSync(installed).mode & 0o777, 0o700)
  const setup = Bun.spawnSync([python, join(installed, "runtime/bridge.py"), "setup"], {
    cwd: installed, env: { ...configured, EXANGELOS_TEAMS_CONFIG: join(installed, "forbidden.json") },
    stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 5000
  })
  assert.equal(setup.exitCode, 1)
  assert.equal(setup.stdout.toString(), "")
  assert.equal(setup.stderr.toString(), "teams_bridge_unavailable\n")
  unchanged("setup-rejected")
  console.log("PASS installed-setup-rejected\n10 installed lifecycle cases passed")
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
