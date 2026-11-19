import { Database } from "bun:sqlite"
import { chmod, copyFile, lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

const repo = join(import.meta.dirname, "../../..")
const version = "1.2.3-e2e"

let root: string
let home: string
let exangelos: string
let xng: string
let template: string
let daemon: Bun.Subprocess | undefined
let release: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined
let releasePort: number

const hostVariable = /^(T3CODE_|CLAUDE_CODE_|CLAUDECODE|CODEX_|XDG_)/

const env = () => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !hostVariable.test(name))),
  EXANGELOS_HOME: home,
  NODE_EXTRA_CA_CERTS: join(root, "release-tls", "cert.pem"),
  // Anything but the local release server goes to a closed port, so no test reaches a real service.
  HTTPS_PROXY: "http://127.0.0.1:9",
  HTTP_PROXY: "http://127.0.0.1:9",
  NO_PROXY: "127.0.0.1",
  HOME: join(root, "user"),
  PATH: `${join(root, "fake-bin")}:${process.env.PATH}`
})

const serviceCalls = () => readFile(join(root, "service-calls.log"), "utf8").catch(() => "")

const noDaemon = /^No Exangelos daemon is running, and starting it failed: .*fake service manager refused.*\. Run `exangelos daemon` in a terminal to start it in the foreground, then retry this command\.$/s

const run = (binary: string, ...args: Array<string>) => {
  const result = Bun.spawnSync([binary, ...args], { cwd: root, env: env(), stdout: "pipe", stderr: "pipe", timeout: 10_000 })
  return { status: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() }
}

const json = (...args: Array<string>) => {
  const result = run(exangelos, "--json", ...args)
  if (result.status !== 0) throw new Error(`${args.join(" ")} failed: ${result.stdout}${result.stderr}`)
  return JSON.parse(result.stdout)
}

const eventually = async <A>(check: () => A | Promise<A>, limit = 20_000): Promise<A> => {
  const deadline = Date.now() + limit
  for (;;) {
    try {
      return await check()
    } catch (error) {
      if (Date.now() > deadline) throw error
      await Bun.sleep(200)
    }
  }
}

const startDaemon = () =>
  Bun.spawn([exangelos, "daemon"], { env: env(), stdout: "pipe", stderr: "pipe" })

const listUntilReady = () => eventually(() => json("connectors"))

const connectorRuns = () =>
  Bun.spawnSync(["pgrep", "-f", join(template, "dist", "main.js")]).exitCode === 0

const abandonSocket = async (path: string) => {
  const listener = Bun.spawn(["bun", "-e", `require("node:net").createServer().listen(${JSON.stringify(path)})`])
  while (!(await lstat(path).then((stats) => stats.isSocket(), () => false))) await Bun.sleep(50)
  listener.kill("SIGKILL")
  await listener.exited
}

const mcpReplies = async (request: unknown) => {
  const mcp = Bun.spawn([exangelos, "mcp"], { env: env(), stdin: "pipe", stdout: "pipe", stderr: "pipe" })
  const frames = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "0" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    request
  ]
  let output = ""
  try {
    mcp.stdin.write(frames.map((frame) => `${JSON.stringify(frame)}\n`).join(""))
    await mcp.stdin.flush()
    const reader = mcp.stdout.getReader()
    while (output.split("\n").filter((line) => line !== "").length < 2) {
      const chunk = await reader.read()
      if (chunk.done) break
      output += new TextDecoder().decode(chunk.value)
    }
  } finally {
    mcp.kill("SIGTERM")
    await mcp.exited
  }
  return output.split("\n").filter((line) => line !== "").map((line) => JSON.parse(line))
}

const mcpSubscribe = async (parameters: Record<string, unknown>, delivery: Record<string, unknown>) => {
  const replies = await mcpReplies({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "subscribe", arguments: { connector: "template", parameters, intent: "Count ticks", ...delivery } }
  })
  expect(replies[1]).toMatchObject({ result: { structuredContent: { id: expect.any(String) } } })
  return replies[1].result.structuredContent as { id: string }
}

const stop = async (child: Bun.Subprocess) => {
  child.kill("SIGTERM")
  const exited = await Promise.race([child.exited.then(() => true), Bun.sleep(10_000).then(() => false)])
  if (!exited) child.kill("SIGKILL")
  return exited
}

const servicePid = () => readFile(join(root, "service.pid"), "utf8").then(Number, () => undefined)

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const stopServiceDaemon = async () => {
  const pid = await servicePid()
  if (pid === undefined || !alive(pid)) return true
  process.kill(pid, "SIGTERM")
  const deadline = Date.now() + 10_000
  while (alive(pid) && Date.now() < deadline) await Bun.sleep(100)
  if (!alive(pid)) return true
  process.kill(-pid, "SIGKILL")
  return false
}

const build = (...args: Array<string>) => {
  const result = Bun.spawnSync(["bun", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
}

const fake = async (name: string, body: string) => {
  const path = join(root, "fake-bin", name)
  await writeFile(path, `#!/bin/sh\n${body}\n`)
  await chmod(path, 0o755)
}

const installFakes = async () => {
  const at = (name: string) => JSON.stringify(join(root, name))
  await mkdir(join(root, "fake-bin"))
  const refuseUnlessAccepting = `[ -f ${at("service-accepts")} ] || { echo "fake service manager refused" >&2; exit 1; }`
  const startDaemonOnce = [
    `alive || {`,
    `perl -MPOSIX -e 'POSIX::setsid(); exec @ARGV' ${JSON.stringify(exangelos)} daemon < /dev/null > ${at("service-daemon.log")} 2>&1 &`,
    `echo $! > ${at("service.pid")};`,
    `tries=0;`,
    `until [ "$(ps -o pgid= -p $! | tr -d ' ')" = "$!" ]; do`,
    `kill -0 $! 2>/dev/null && [ $tries -lt 100 ] || { echo "the daemon did not start in its own process group" >&2; exit 1; };`,
    `tries=$((tries + 1)); sleep 0.05;`,
    `done;`,
    `}`
  ].join(" ")
  const aliveCheck = `alive() { [ -f ${at("service.pid")} ] && kill -0 "$(cat ${at("service.pid")})" 2>/dev/null; }`
  await fake("launchctl", [
    `echo "launchctl $*" >> ${at("service-calls.log")}`,
    refuseUnlessAccepting,
    aliveCheck,
    `case "$1" in`,
    `  print) alive || exit 113; printf '\\tstate = running\\n\\tpid = %s\\n' "$(cat ${at("service.pid")})" ;;`,
    `  bootstrap|kickstart) ${startDaemonOnce} ;;`,
    `  bootout) alive && kill "$(cat ${at("service.pid")})" ;;`,
    `esac`,
    `exit 0`
  ].join("\n"))
  await fake("systemctl", [
    `echo "systemctl $*" >> ${at("service-calls.log")}`,
    refuseUnlessAccepting,
    aliveCheck,
    `state() { alive && echo active || echo inactive; }`,
    `case " $* " in`,
    `  *" start "*|*" restart "*) ${startDaemonOnce} ;;`,
    `  *" is-active "*) state; alive || exit 3 ;;`,
    `  *" ActiveState "*) state ;;`,
    `  *" MainPID "*) if alive; then cat ${at("service.pid")}; else echo 0; fi ;;`,
    `esac`,
    `exit 0`
  ].join("\n"))
  await fake("security", [
    `echo "security $*" >> ${at("secret-calls.log")}`,
    `case "$1" in`,
    `  -i) cat >> ${at("secrets.log")} ;;`,
    `  find-generic-password) service=$(printf '%s\\n' "$*" | sed -n 's/.*-s \\([^ ]*\\).*/\\1/p');`,
    `    grep -qs -- "-s \\"$service\\"" ${at("secrets.log")} || exit 44; echo not-a-secret ;;`,
    `esac`,
    `exit 0`
  ].join("\n"))
  await fake("secret-tool", `echo "fake Secret Service is unreachable" >&2; exit 2`)
  await fake("t3", `{ printf '%s\\n' "$*"; cat; printf '\\n'; } >> ${at("wakes.log")}`)
  for (const notifier of ["osascript", "notify-send"]) {
    await fake(notifier, `echo "${notifier} $*" >> ${at("notifications.log")}`)
  }
}

// The release server runs in its own process: the tests block on the binary while the daemon downloads.
const serveRelease = async (directory: string) => {
  const tls = join(root, "release-tls")
  await mkdir(tls)
  const certificate = Bun.spawnSync([
    "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=127.0.0.1",
    "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", join(tls, "key.pem"), "-out", join(tls, "cert.pem")
  ], { stdout: "ignore", stderr: "pipe" })
  if (certificate.exitCode !== 0) throw new Error(certificate.stderr.toString())
  // Besides the archives it stands in for the GitHub and Jira calls of Configure and Describe, and logs each request.
  const server = `
    const [directory, tls, log] = process.argv.slice(1)
    const api = {
      "POST /api/graphql": { data: { viewer: { login: "e2e" } } },
      "GET /rest/api/3/serverInfo": { deploymentType: "Cloud" },
      "GET /rest/api/3/myself": { accountId: "e2e" },
      "GET /rest/api/3/search/jql": { issues: [{ id: "1", key: "E2E-1", fields: { summary: "One" } }], isLast: true }
    }
    const served = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      tls: { cert: Bun.file(tls + "/cert.pem"), key: Bun.file(tls + "/key.pem") },
      fetch: async (request) => {
        const url = new URL(request.url)
        const route = request.method + " " + url.pathname
        require("node:fs").appendFileSync(log, route + url.search + "\\n")
        if (route in api) return Response.json(api[route])
        const file = Bun.file(directory + new URL(request.url).pathname)
        return (await file.exists()) ? new Response(file) : new Response("not found", { status: 404 })
      }
    })
    console.log(served.port)
  `
  release = Bun.spawn(["bun", "-e", server, directory, tls, join(root, "release-requests.log")], { stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  const { value } = await release.stdout.getReader().read()
  return Number(new TextDecoder().decode(value).trim())
}

beforeAll(async () => {
  root = await mkdtemp("/tmp/xng-")
  home = join(root, "h")
  exangelos = join(root, "bin", "exangelos")
  xng = join(root, "bin", "xng")
  template = join(root, "sources", "template")
  const releaseDirectory = join(root, "release")
  build("packaging/src/cli/build-connectors.ts", "--out", releaseDirectory)
  const official = await readFile(join(releaseDirectory, "official-connectors.json"), "utf8")
  releasePort = await serveRelease(releaseDirectory)
  build(
    "apps/cli/build.ts",
    "--version",
    version,
    "--release-url",
    `https://127.0.0.1:${releasePort}`,
    "--official-connectors",
    JSON.stringify(JSON.parse(official)),
    "--outfile",
    exangelos
  )
  await symlink(exangelos, xng)
  await installFakes()
  build("build", "connectors/template/src/main.ts", "--target=bun", `--outfile=${join(template, "dist", "main.js")}`)
  await copyFile(join(repo, "connectors/template/connector.json"), join(template, "connector.json"))
  await writeFile(join(root, "token"), "not-a-secret")
}, 300_000)

afterAll(async () => {
  if (daemon !== undefined) await stop(daemon)
  await stopServiceDaemon()
  Bun.spawnSync(["pkill", "-f", join(template, "dist", "main.js")])
  Bun.spawnSync(["pkill", "-f", join(home, "connectors")])
  if (release !== undefined) await stop(release)
  await rm(root, { recursive: true, force: true })
})

describe("the exangelos binary", () => {
  it("prints its version under either name", () => {
    expect(run(exangelos, "--version")).toEqual({ status: 0, stdout: `exangelos ${version}\n`, stderr: "" })
    expect(run(xng, "--version")).toEqual({ status: 0, stdout: `exangelos ${version}\n`, stderr: "" })
  })

  it("tries to start the service on first use and says why it could not", async () => {
    const result = run(xng, "connectors")
    expect(result.status).toBe(1)
    expect(result.stdout).toBe("")
    expect(result.stderr.trim()).toMatch(noDaemon)
    expect(await serviceCalls()).toMatch(/^(launchctl|systemctl) /)
  })

  it("answers an MCP call with the no-daemon text when the start fails", async () => {
    const replies = await mcpReplies({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list", arguments: {} } })
    expect(replies.map((reply) => reply.id)).toEqual([1, 2])
    expect(replies[1].result.isError).toBe(true)
    expect(replies[1].result.content[0].text).toMatch(/^No Exangelos daemon is running, and starting it failed: .*fake service manager refused/s)
  }, 15_000)

  it("serves the template connector's catalogue from a daemon that replaced a stale socket", async () => {
    await mkdir(home, { recursive: true })
    await abandonSocket(join(home, "daemon.sock"))
    daemon = startDaemon()
    expect(await listUntilReady()).toEqual([])
    expect(run(exangelos, "connector", "dev-link", template).status).toBe(0)
    const connectors = await eventually(() => {
      const listed = json("connectors")
      expect(listed).toMatchObject([{ process: "running" }])
      return listed
    })
    expect(connectors).toMatchObject([
      {
        name: "template",
        trust: "dev",
        catalogue: { eventTypes: [{ type: "tick", description: "One tick of the countdown" }] }
      }
    ])
    const socket = await lstat(join(home, "daemon.sock"))
    expect(socket.isSocket()).toBe(true)
    expect(socket.mode & 0o777).toBe(0o600)
    expect(connectorRuns()).toBe(true)
  }, 30_000)

  it("applied the migrations to the database", () => {
    const database = new Database(join(home, "exangelos.db"), { readonly: true })
    const tables = database.query<{ name: string }, []>("select name from sqlite_master where type = 'table'").all()
    const migrations = database.query<{ migration_id: number }, []>("select migration_id from effect_sql_migrations").all()
    database.close()
    expect(tables.map((table) => table.name)).toEqual(
      expect.arrayContaining(["connectors", "connector_values", "connector_changes", "subscriptions", "events", "wakes"])
    )
    expect(migrations).toEqual([{ migration_id: 1 }])
  })

  it("serves the agent tools over MCP with only frames on stdout", async () => {
    const replies = await mcpReplies({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })
    expect(replies.map((reply) => reply.id)).toEqual([1, 2])
    expect(replies[0].result.serverInfo).toMatchObject({ name: "exangelos", version })
    const tools = replies[1].result.tools.map((tool: { name: string }) => tool.name)
    expect([...tools].sort()).toEqual(
      ["ack", "cancel", "events", "list", "list_connectors", "pause", "resume", "retarget", "set_event_alerts", "show", "subscribe", "update", "wait"]
    )
  }, 15_000)

  it("wakes a subscriber through t3, then reads, acknowledges and waits on a pull-only subscription", async () => {
    json("settings", "set", "limits.wakeWindow=0 millis")
    await eventually(() =>
      json("connector", "configure", "template", "interval=0", "--secret-file", `token=${join(root, "token")}`)
    )
    if (process.platform === "darwin") {
      expect(await readFile(join(root, "secret-calls.log"), "utf8")).toMatch(/^security -i$/m)
    }

    const woken = await mcpSubscribe({ ticks: 3 }, { target: { harness: "t3", sessionId: "e2e-thread" } })
    const wakes = await eventually(async () => {
      const text = await readFile(join(root, "wakes.log"), "utf8")
      expect(text).toContain(woken.id)
      return text
    })
    expect(wakes.split("\n")[0]).toBe("thread send -- e2e-thread -")

    const events = await eventually(() => {
      const read = json("events", woken.id)
      expect(read).toHaveLength(3)
      return read
    })
    expect(events.map((event: { payload: unknown }) => event.payload)).toEqual([{ index: 1 }, { index: 2 }, { index: 3 }])
    expect(json("ack", woken.id, "--through", String(events[2].number))).toMatchObject({ ackedThrough: events[2].number })

    const pulled = await mcpSubscribe({ ticks: 2 }, { pullOnly: true, similarOk: [woken.id] })
    const waited = run(exangelos, "--json", "wait", pulled.id)
    expect(waited.status).toBe(0)
    const { wake } = JSON.parse(waited.stdout)
    expect(wake.subscription).toBe(pulled.id)
    expect(wake.pending.length).toBeGreaterThan(0)
    expect(json("list").map((subscription: { id: string }) => subscription.id).sort()).toEqual([woken.id, pulled.id].sort())
  }, 60_000)

  it("wakes a subscriber through a harness you define, with the values in its arguments and the text on stdin", async () => {
    const log = join(root, "harness-wakes.log")
    await fake("e2e-relay", `{ for arg in "$@"; do printf 'arg:%s\\n' "$arg"; done; cat; printf '\\n'; } >> ${JSON.stringify(log)}`)
    const relay = join(root, "fake-bin", "e2e-relay")
    const settings = json("settings", "harness", "set", "e2e-cmd", "--", relay, "--session={session}", "{subscription}")
    expect(settings.harnesses).toEqual({ "e2e-cmd": { command: [relay, "--session={session}", "{subscription}"] } })

    const woken = await mcpSubscribe({ ticks: 2 }, { target: { harness: "e2e-cmd", sessionId: "e2e-session" } })
    const wakes = await eventually(async () => {
      const text = await readFile(log, "utf8")
      expect(text).toContain(`arg:${woken.id}`)
      return text
    })
    const lines = wakes.split("\n")
    expect(lines.slice(0, 2)).toEqual(["arg:--session=e2e-session", `arg:${woken.id}`])
    expect(lines.slice(2).join("\n")).toContain(woken.id)
  }, 60_000)

  it("refuses a second daemon beside a live one", () => {
    const second = run(exangelos, "daemon")
    expect(second.status).toBe(1)
    expect(second.stderr.trim()).toBe(`a daemon already runs on ${join(home, "daemon.sock")}`)
    expect(run(exangelos, "connectors").status).toBe(0)
  })

  it("stops with its connector and leaves no daemon behind", async () => {
    expect(await stop(daemon!)).toBe(true)
    daemon = undefined
    expect(connectorRuns()).toBe(false)
    expect(run(exangelos, "connectors").stderr.trim()).toMatch(noDaemon)
  }, 15_000)

  it("logs the daemon and each command without the configured secret", async () => {
    const logs = join(home, "logs")
    const names = await readdir(logs)
    expect(names).toEqual(expect.arrayContaining(["cli.jsonl", "daemon.jsonl"]))
    for (const name of names) expect(await readFile(join(logs, name), "utf8")).not.toContain("not-a-secret")
    expect(await readFile(join(logs, "daemon.jsonl"), "utf8")).toContain("daemon stopped")

    const records = async (name: string) =>
      (await readFile(join(logs, name), "utf8")).trim().split("\n").map((line) => JSON.parse(line))
    for (const flags of [["--json"], ["--json", "false"]]) {
      const server = Bun.spawnSync([exangelos, ...flags, "mcp"], { env: env(), stdin: "ignore", timeout: 10_000 })
      expect((await records("mcp.jsonl")).filter((record) => record.pid === server.pid)).toMatchObject([
        { level: "INFO", src: "mcp", msg: "mcp started", ann: { version: expect.any(String) } }
      ])
      expect((await records("cli.jsonl")).filter((record) => record.pid === server.pid)).toEqual([])
    }
    for (const args of [["--json", "false", "settings"], ["--log-level", "warn", "settings"], ["--version"], ["--help"]]) {
      const command = Bun.spawnSync([exangelos, ...args], { env: env(), timeout: 10_000 })
      expect((await records("cli.jsonl")).filter((record) => record.pid === command.pid)).toMatchObject([
        { level: "INFO", src: "cli", msg: "cli started", ann: { version: expect.any(String) } }
      ])
    }
  }, 30_000)

  it("starts the daemon through the service manager on first use and reports its status", async () => {
    await writeFile(join(root, "service-accepts"), "")
    const listed = run(exangelos, "--json", "connectors")
    expect(listed.stderr).toBe("")
    expect(listed.status).toBe(0)
    expect(JSON.parse(listed.stdout)).toMatchObject([{ name: "template", trust: "dev" }])
    expect(alive((await servicePid())!)).toBe(true)

    const status = run(exangelos, "service", "status")
    expect(status.status).toBe(0)
    expect(status.stdout).toMatch(/running/i)
    expect(status.stderr).not.toMatch(/\n\s+at /)

    expect(await stopServiceDaemon()).toBe(true)
    expect(connectorRuns()).toBe(false)
    await rm(join(root, "service-accepts"))
  }, 30_000)

  it("scaffolds a renamed copy of the connector template", async () => {
    expect(run(exangelos, "connector", "scaffold", "template-feed").status).toBe(0)
    const directory = join(root, "template-feed")
    expect(JSON.parse(await readFile(join(directory, "connector.json"), "utf8")).name).toBe("template-feed")
    expect(JSON.parse(await readFile(join(directory, "package.json"), "utf8")).name).toBe("@exangelos/connector-template-feed")
    expect(await readFile(join(directory, "src", "index.ts"), "utf8")).toBe(`export * as TemplateFeed from "./TemplateFeed.ts"\n`)
    expect(await readFile(join(directory, "README.md"), "utf8")).toContain("builds only inside the Exangelos monorepo")
    expect(run(exangelos, "connector", "scaffold", "template-feed").status).toBe(1)
  })

  it("cross-compiles for Linux x64 into an ELF executable", async () => {
    const linux = join(root, "bin", "exangelos-linux-x64")
    build("apps/cli/build.ts", "--target=bun-linux-x64", "--outfile", linux)
    expect((await readFile(linux)).subarray(0, 4)).toEqual(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
  }, 120_000)
})

describe("local logs and the debug report", () => {
  const seeded = ["seeded-token-value", "seeded-key-value", "seeded-bearer-value", "seeded-env-value", "payload-marker-123", "seeded-cookie-value"]
  let logsHome: string
  const logsEnv = (extra: Record<string, string> = {}) => ({ ...env(), EXANGELOS_HOME: logsHome, ...extra })
  const inLogs = (...args: Array<string>) => {
    const result = Bun.spawnSync([exangelos, ...args], { cwd: root, env: logsEnv(), stdout: "pipe", stderr: "pipe", timeout: 20_000 })
    return { status: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() }
  }
  const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString()
  const record = (fields: Record<string, unknown>) => `${JSON.stringify({ pid: 41, src: "daemon", ...fields })}\n`

  beforeAll(async () => {
    logsHome = join(root, "logs-home")
    const logs = join(logsHome, "logs")
    await mkdir(logs, { recursive: true })
    await writeFile(join(logs, "daemon.1.jsonl"), record({ t: at(180), level: "INFO", msg: "daemon started", ann: { connector: "jira" } }))
    await writeFile(
      join(logs, "daemon.jsonl"),
      record({
        t: at(30),
        level: "DEBUG",
        msg: "event received",
        ann: { connector: "jira", apiToken: "seeded-token-value", payload: { body: "payload-marker-123" } }
      }) + "not a record\n" + record({ t: at(20), level: "WARN", msg: "wake failed apiKey=seeded-key-value", ann: { connector: "github-pr" } })
    )
    await writeFile(join(logs, "mcp.jsonl"), record({ t: at(10), level: "INFO", src: "mcp", msg: "mcp started" }))
    await writeFile(join(logs, "daemon.log"), "booting\nAuthorization: Bearer seeded-bearer-value\nCookie: sid=first; session=seeded-cookie-value\n")
    await writeFile(
      join(logsHome, "settings.json"),
      JSON.stringify({ logLevel: "debug", harnesses: { mine: { command: ["run"], env: { GITHUB_TOKEN: "seeded-env-value" } } } })
    )
  })

  it("prints recent records, merged and filtered, as JSON or for people", () => {
    const records = (result: { stdout: string }) => result.stdout.trim().split("\n").map((line) => JSON.parse(line).msg)
    expect(records(inLogs("--json", "logs", "--level", "warn"))).toEqual(["wake failed apiKey=seeded-key-value"])
    expect(records(inLogs("--json", "logs", "--since", "1h", "--connector", "jira"))).toEqual(["event received"])
    expect(records(inLogs("--json", "logs", "--source", "daemon"))).toEqual([
      "daemon started",
      "event received",
      "wake failed apiKey=seeded-key-value"
    ])
    const people = inLogs("logs", "--source", "daemon", "-n", "2")
    expect(people.status).toBe(0)
    const lines = people.stdout.trim().split("\n")
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatch(/^\S+Z DEBUG daemon\[41\] event received connector=jira/)
    expect(lines[1]).toMatch(/^\S+Z WARN  daemon\[41\] wake failed/)
    const wrong = inLogs("logs", "--since", "yesterday")
    expect(wrong.status).not.toBe(0)
    expect(wrong.stderr).toContain("--since takes a span")
  })

  it("follows new records with -f", async () => {
    const follower = Bun.spawn([exangelos, "logs", "-f", "--source", "mcp", "-n", "0"], { env: logsEnv(), stdout: "pipe", stderr: "ignore" })
    let seen = ""
    const reading = (async () => {
      for await (const chunk of follower.stdout) seen += Buffer.from(chunk).toString()
    })()
    try {
      await Bun.sleep(1_000)
      await writeFile(join(logsHome, "logs", "mcp.jsonl"), record({ t: at(0), level: "INFO", src: "mcp", msg: "followed line" }), { flag: "a" })
      await eventually(() => expect(seen).toContain("followed line"), 10_000)
      expect(seen).not.toContain("mcp started")
    } finally {
      follower.kill()
      await reading
    }
  }, 20_000)

  it("writes a redacted debug report without starting the daemon", async () => {
    const callsBefore = await serviceCalls()
    const archive = join(root, "debug-report.tar.gz")
    const made = inLogs("debug", "report", "--output", archive)
    expect(made.stderr).toBe("")
    expect(made.status).toBe(0)
    expect(made.stdout).toContain(`Wrote ${archive}`)
    expect(made.stdout).toContain("report.json")
    expect(await serviceCalls()).toBe(callsBefore)

    const listing = Bun.spawnSync(["tar", "-tzf", archive]).stdout.toString().trim().split("\n").map((name) => name.replace(/^[^/]+\//, ""))
    expect(listing).toEqual(expect.arrayContaining([
      "report.json",
      "daemon.log",
      "logs/daemon.jsonl",
      "logs/daemon.1.jsonl",
      "logs/mcp.jsonl",
      "logs/cli.jsonl"
    ]))
    const unpacked = join(root, "debug-report")
    await mkdir(unpacked)
    expect(Bun.spawnSync(["tar", "-xzf", archive, "-C", unpacked]).exitCode).toBe(0)
    const [top] = await readdir(unpacked)
    const files = (await readdir(join(unpacked, top!), { recursive: true })).filter((name) => name.includes("."))
    for (const name of files) {
      const content = await readFile(join(unpacked, top!, name), "utf8")
      for (const secret of seeded) expect(content, `${name} holds ${secret}`).not.toContain(secret)
    }
    const report = JSON.parse(await readFile(join(unpacked, top!, "report.json"), "utf8"))
    expect(report).toMatchObject({
      exangelos: { version, digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/) },
      os: { platform: process.platform, arch: process.arch },
      installMethod: { _tag: "Standalone" },
      paths: { logDir: join(logsHome, "logs") },
      logLevel: { setting: "debug", envVar: "EXANGELOS_LOG_LEVEL", envVarSet: false },
      settings: { harnesses: { mine: { env: { GITHUB_TOKEN: "[redacted]" } } } },
      daemon: { running: false },
      connectorDirectory: [],
      logs: { payloads: "dropped", skippedLines: 1 }
    })
  }, 30_000)

  it("keeps payloads on request, writes to the reports folder by default, and refuses agent sessions", async () => {
    const made = JSON.parse(inLogs("--json", "debug", "report", "--include-payloads").stdout)
    expect(made.path.startsWith(join(logsHome, "reports", "exangelos-debug-"))).toBe(true)
    expect(made.path).toMatch(/exangelos-debug-\d{8}T\d{6}Z\.tar\.gz$/)
    const unpacked = join(root, "debug-report-payloads")
    await mkdir(unpacked)
    expect(Bun.spawnSync(["tar", "-xzf", made.path, "-C", unpacked]).exitCode).toBe(0)
    const [top] = await readdir(unpacked)
    const daemonLog = await readFile(join(unpacked, top!, "logs", "daemon.jsonl"), "utf8")
    expect(daemonLog).toContain("payload-marker-123")
    expect(daemonLog).not.toContain("seeded-token-value")

    const refused = Bun.spawnSync([exangelos, "debug", "report"], { env: logsEnv({ CODEX_THREAD_ID: "thread-1" }), timeout: 10_000 })
    expect(refused.exitCode).not.toBe(0)
    expect(refused.stderr.toString()).toContain("inside an agent session")
  }, 30_000)

  it("keeps an existing file, and leaves nothing behind when tar fails", async () => {
    const existing = join(root, "kept.tar.gz")
    await writeFile(existing, "keep me")
    const taken = inLogs("debug", "report", "--output", existing)
    expect(taken.status).not.toBe(0)
    expect(taken.stderr).toContain("already exists")
    expect(await readFile(existing, "utf8")).toBe("keep me")

    const broken = join(root, "broken-tar")
    await mkdir(broken, { recursive: true })
    await writeFile(join(broken, "tar"), "#!/bin/sh\nexit 3\n")
    await chmod(join(broken, "tar"), 0o755)
    const out = join(root, "failed", "report.tar.gz")
    const failed = Bun.spawnSync([exangelos, "debug", "report", "--output", out], {
      env: logsEnv({ PATH: `${broken}:${process.env.PATH}` }),
      timeout: 20_000
    })
    expect(failed.exitCode).not.toBe(0)
    expect(failed.stderr.toString()).toContain("tar exited with code 3")
    expect(await readdir(join(root, "failed"))).toEqual([])
  }, 30_000)
})

describe("official connectors from a release address", () => {
  const archive = (name: string) => `${name}-0.1.0.tar.gz`

  // Serves the archive with one byte of its bundle changed, keeping the original to restore.
  const tamper = async (name: string) => {
    const served = join(root, "release", archive(name))
    const unpacked = join(root, "tampered", name)
    await mkdir(unpacked, { recursive: true })
    await copyFile(served, join(root, "tampered", archive(name)))
    expect(Bun.spawnSync(["tar", "-xzf", served, "-C", unpacked]).exitCode).toBe(0)
    const entry = join(unpacked, "dist", "main.js")
    const bytes = await readFile(entry)
    bytes[bytes.length - 1] = bytes[bytes.length - 1] === 0x0a ? 0x20 : 0x0a
    await writeFile(entry, bytes)
    expect(Bun.spawnSync(["tar", "-czf", served, "-C", unpacked, "connector.json", "dist/main.js"]).exitCode).toBe(0)
  }

  const connectorNamed = (name: string) => json("connectors").find((connector: { name: string }) => connector.name === name)

  it("refuses a tampered official archive and leaves the connector inert", async () => {
    daemon = startDaemon()
    await listUntilReady()
    await tamper("file-watch")
    const refused = run(exangelos, "subscribe", "file-watch", join(root, "drops", "*.txt"), "--intent", "Watch drops", "--pull-only")
    expect(refused.status).toBe(1)
    expect(refused.stderr.trim()).toMatch(/^file-watch is unavailable: its checksum does not match the one this binary carries\./)
    expect(connectorNamed("file-watch")).toMatchObject({ trust: "inert" })
    expect(run(exangelos, "connector", "remove", "file-watch").status).toBe(0)
    await copyFile(join(root, "tampered", archive("file-watch")), join(root, "release", archive("file-watch")))
  }, 30_000)

  it("fetches github-pr and jira, and describes a subscription to each against a local stand-in", async () => {
    const stored = async (field: string, value: string) => {
      const path = join(root, `${field}-value`)
      await writeFile(path, value)
      return `${field}=${path}`
    }
    const local = `127.0.0.1:${releasePort}`
    const connectors = [
      { name: "github-pr", main: "o/r#1", eventType: "merge.ready", described: { label: "Pull request o/r#1" }, values: ["--secret-file", await stored("host", local)] },
      { name: "jira", main: "project = E2E", eventType: "status.changed", described: {}, values: ["email=e2e@example.invalid", "--secret-file", await stored("site", `https://${local}`)] }
    ]
    for (const { described, eventType, main, name, values } of connectors) {
      // Without credentials the connector stops at Configure, before any request.
      const refused = run(exangelos, "subscribe", name, main, "--intent", "Describe only", "--pull-only")
      expect(refused.status).toBe(1)
      expect(refused.stderr.trim()).toBe(`${name} is unavailable: its configuration is missing. Run \`exangelos connectors ${name}\` to see its state.`)
      expect(connectorNamed(name)).toMatchObject({ trust: "enabled", origin: { _tag: "Official" } })

      const configured = run(exangelos, "connector", "configure", name, ...values, "--secret-file", await stored("token", "not-a-secret"))
      expect(configured.status, configured.stdout + configured.stderr).toBe(0)
      const subscribed = run(exangelos, "--json", "subscribe", name, main, "--intent", "Describe only", "--pull-only")
      expect(subscribed.status, subscribed.stdout + subscribed.stderr).toBe(0)
      const subscription = JSON.parse(subscribed.stdout)
      expect(subscription).toMatchObject({ connector: name, subject: expect.any(String), ...described })
      expect(run(exangelos, "cancel", subscription.id).status).toBe(0)
      expect(connectorNamed(name).catalogue.eventTypes.map((spec: { type: string }) => spec.type)).toContain(eventType)
    }
    const requests = (await readFile(join(root, "release-requests.log"), "utf8")).split("\n")
    expect(requests).toEqual(expect.arrayContaining(["POST /api/graphql", "GET /rest/api/3/serverInfo", "GET /rest/api/3/myself"]))
    // Jira's Describe checks the JQL with a one-result search; Watch searches without that limit.
    expect(requests.some((line) => /^GET \/rest\/api\/3\/search\/jql\?.*maxResults=1(&|$)/.test(line))).toBe(true)
  }, 60_000)

  it("wakes once for a file event beside a template subscription, and switches event alerts", async () => {
    const drops = join(root, "drops")
    await mkdir(drops, { recursive: true })
    await eventually(() =>
      json("connector", "configure", "template", "interval=500", "--secret-file", `token=${join(root, "token")}`)
    )
    const ticks = await mcpSubscribe({ ticks: 120 }, { pullOnly: true, similarOk: json("list").map((s: { id: string }) => s.id) })
    const subscribed = run(exangelos, "--json", "subscribe", "file-watch", join(drops, "*.txt"), "--intent", "Watch drops", "--target", "t3:e2e-files")
    expect(subscribed.status, subscribed.stdout + subscribed.stderr).toBe(0)
    const files = JSON.parse(subscribed.stdout) as { id: string }
    expect(connectorNamed("file-watch")).toMatchObject({ trust: "enabled", catalogue: { eventTypes: expect.arrayContaining([expect.objectContaining({ type: "file.created" })]) } })

    expect(json("alerts", files.id, "on")).toMatchObject({ id: files.id, eventAlerts: true })
    expect(json("show", files.id).subscription.eventAlerts).toBe(true)

    const drop = join(drops, "one.txt")
    const oneEvent = () => {
      const read = json("events", files.id)
      expect(read).toHaveLength(1)
      return read
    }
    await writeFile(drop, "one")
    // The watcher's first scan takes the files it finds as its baseline. A file written before that scan
    // raises nothing, so the test rewrites it once, which raises file.changed instead.
    if (!(await eventually(oneEvent, 5_000).then(() => true, () => false))) await writeFile(drop, "one again")
    const events = await eventually(oneEvent)
    expect(events[0]).toMatchObject({ type: expect.stringMatching(/^file\.(created|changed)$/), payload: { path: expect.stringMatching(/one\.txt$/) } })
    const wakesFor = async () =>
      (await readFile(join(root, "wakes.log"), "utf8")).split("thread send -- ").filter((block) => block.includes(files.id))
    await eventually(async () => expect(await wakesFor()).toHaveLength(1))
    await Bun.sleep(1_000)
    const wakes = await wakesFor()
    expect(wakes).toHaveLength(1)
    expect(wakes[0]!.startsWith("e2e-files -")).toBe(true)
    expect(json("show", files.id).wakes).toHaveLength(1)
    const template = json("show", ticks.id)
    expect(template.subscription.state._tag).not.toBe("Ended")
    expect(template.events.length).toBeGreaterThan(0)
    expect(run(exangelos, "cancel", ticks.id).status).toBe(0)
    const alerted = await eventually(async () => {
      const lines = (await readFile(join(root, "notifications.log"), "utf8")).split("\n").filter((line) => line.includes("one.txt"))
      expect(lines).toHaveLength(1)
      return lines[0]
    })
    expect(alerted).toMatch(/^(osascript|notify-send) /)

    expect(json("alerts", files.id, "off")).toMatchObject({ eventAlerts: false })
    expect(json("show", files.id).subscription.eventAlerts).toBe(false)
  }, 60_000)

  it("stops and leaves no daemon or connector process behind", async () => {
    expect(await stop(daemon!)).toBe(true)
    daemon = undefined
    expect(Bun.spawnSync(["pgrep", "-f", join(home, "connectors")]).exitCode).toBe(1)
    expect(connectorRuns()).toBe(false)
    expect(run(exangelos, "connectors").stderr.trim()).toMatch(noDaemon)
  }, 15_000)
})

describe("secrets at the connector stderr and debug report boundaries", () => {
  const filesUnder = async (directory: string): Promise<Array<string>> =>
    (await readdir(directory, { recursive: true, withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map((entry) => join(entry.parentPath, entry.name))

  const unpack = async (archive: string) => {
    const directory = await mkdtemp(join(root, "unpacked-"))
    expect(Bun.spawnSync(["tar", "-xzf", archive, "-C", directory]).exitCode).toBe(0)
    return directory
  }

  const holding = async (directory: string, value: string) => {
    const found: Array<string> = []
    for (const file of await filesUnder(directory)) if ((await readFile(file, "utf8")).includes(value)) found.push(file)
    return found
  }

  it("keeps an inherited token and a short stored credential out of every log and report, and payloads out by default", async () => {
    const envMarker = "e2e-env-value-7c41d0"
    const shortEnvMarker = "Wq8"
    const shortMarker = "qZ7"
    const payloadMarker = "e2e-echoed-note-52ab"
    const sharedHome = home
    home = join(root, "h-secrets")
    const echo = join(root, "sources", "echo")
    const records = async () =>
      (await readFile(join(home, "logs", "daemon.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line))
    const echoed = (prefix: string, count: number) =>
      eventually(async () => {
        const found = (await records()).filter((r) => r.msg.startsWith(`connector stderr ${prefix}`) && r.ann?.connector === "echo")
        expect(found.length).toBeGreaterThanOrEqual(count)
        return found.map((r) => r.msg as string)
      })
    const configure = async (token: string) => {
      await writeFile(join(root, "echo-token"), token)
      json("connector", "configure", "echo", "--secret-file", `token=${join(root, "echo-token")}`)
    }
    try {
      await mkdir(home, { recursive: true })
      build("build", "apps/cli/e2e/echo-connector.ts", "--target=bun", `--outfile=${join(echo, "dist", "main.js")}`)
      await writeFile(
        join(echo, "connector.json"),
        JSON.stringify({ name: "echo", version: "0.1.0", entry: { _tag: "Bundle", path: "dist/main.js" } })
      )
      daemon = Bun.spawn([exangelos, "daemon"], {
        env: { ...env(), XNG_E2E_TOKEN: envMarker, XNG_E2E_SHORT_TOKEN: shortEnvMarker },
        stdout: "ignore",
        stderr: "ignore"
      })
      await listUntilReady()
      expect(run(exangelos, "connector", "dev-link", echo).status).toBe(0)
      expect(await echoed("startup echo", 1)).toEqual(["connector stderr startup echo [redacted] [redacted]"])

      await configure(shortMarker)
      expect((await echoed("configure echo", 1)).at(-1)).toBe("connector stderr configure echo [redacted] joined[redacted]x")
      expect(await stop(daemon)).toBe(true)
      daemon = startDaemon()
      await listUntilReady()
      expect((await echoed("configure echo", 2)).at(-1)).toBe("connector stderr configure echo [redacted] joined[redacted]x")

      json("settings", "set", "logLevel=debug")
      await configure("payload")
      expect((await echoed("configure echo", 3)).at(-1)).toBe("connector stderr configure echo [redacted] joined[redacted]x")
      const multiline = ["e2e-multi-first-91", "e2e-multi-second-92"]
      await configure(multiline.join("\n"))
      expect((await echoed("configure echo", 4)).at(-1)).toBe("connector stderr configure echo [redacted]")
      const replies = await mcpReplies({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "subscribe", arguments: { connector: "echo", parameters: { note: payloadMarker }, intent: "Echo a note", pullOnly: true } }
      })
      const subscription = replies[1].result.structuredContent.id as string
      const event = await eventually(async () => {
        const found = (await records()).find((r) => r.level === "DEBUG" && r.ann?.subscription === subscription && r.ann?.payload)
        expect(found).toBeDefined()
        return found
      })
      expect(JSON.stringify(event.ann.payload)).toContain(payloadMarker)

      expect(run(exangelos, "debug", "report", "--output", join(root, "secrets-report.tar.gz")).status).toBe(0)
      const online = await unpack(join(root, "secrets-report.tar.gz"))
      expect(await holding(online, payloadMarker)).toEqual([])
      expect(run(exangelos, "debug", "report", "--include-payloads", "--output", join(root, "secrets-payloads.tar.gz")).status).toBe(0)
      const withPayloads = await unpack(join(root, "secrets-payloads.tar.gz"))
      expect(await holding(withPayloads, payloadMarker)).not.toEqual([])
      expect(await stop(daemon)).toBe(true)
      daemon = undefined

      expect(run(exangelos, "debug", "report", "--output", join(root, "secrets-offline.tar.gz")).status).toBe(0)
      const offline = await unpack(join(root, "secrets-offline.tar.gz"))
      const [reportFile] = (await filesUnder(offline)).filter((file) => file.endsWith("report.json"))
      const report = JSON.parse(await readFile(reportFile!, "utf8"))
      expect(report.daemon.running).toBe(false)
      expect(report.daemon.connectors).toEqual([
        expect.objectContaining({
          name: "echo",
          version: "0.1.0",
          origin: expect.objectContaining({ _tag: "DevLink" }),
          digest: expect.stringMatching(/.+/),
          trust: "dev",
          configuration: { _tag: "Set" },
          process: "unavailable while the daemon is not running"
        })
      ])

      for (const marker of [envMarker, shortEnvMarker, shortMarker, ...multiline]) {
        expect(await holding(join(home, "logs"), marker)).toEqual([])
        expect(await holding(online, marker)).toEqual([])
        expect(await holding(withPayloads, marker)).toEqual([])
        expect(await holding(offline, marker)).toEqual([])
      }
      expect(await holding(offline, payloadMarker)).toEqual([])
    } finally {
      if (daemon) await stop(daemon)
      daemon = undefined
      Bun.spawnSync(["pkill", "-f", join(echo, "dist", "main.js")])
      home = sharedHome
    }
  }, 60_000)
})
