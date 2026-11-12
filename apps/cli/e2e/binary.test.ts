import { Database } from "bun:sqlite"
import { copyFile, lstat, mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

const repo = join(import.meta.dirname, "../../..")
const version = "1.2.3-e2e"

let root: string
let home: string
let exangelos: string
let xng: string
let daemon: Bun.Subprocess | undefined

const env = () => ({ ...process.env, EXANGELOS_HOME: home, T3CODE_THREAD_ID: "", CLAUDE_CODE_SESSION_ID: "", CODEX_THREAD_ID: "" })

const run = (binary: string, ...args: Array<string>) => {
  const result = Bun.spawnSync([binary, ...args], { env: env(), stdout: "pipe", stderr: "pipe", timeout: 10_000 })
  return { status: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() }
}

const startDaemon = () =>
  Bun.spawn([exangelos, "daemon"], { env: env(), stdout: "pipe", stderr: "pipe" })

const listUntilReady = async () => {
  const deadline = Date.now() + 20_000
  for (;;) {
    const result = run(exangelos, "plugins")
    if (result.status === 0) return result
    if (Date.now() > deadline) throw new Error(`daemon never answered: ${result.stderr}`)
    await Bun.sleep(200)
  }
}

const pluginRuns = () =>
  Bun.spawnSync(["pgrep", "-f", join(home, "plugins", "template", "dist", "main.js")]).exitCode === 0

const abandonSocket = async (path: string) => {
  const listener = Bun.spawn(["bun", "-e", `require("node:net").createServer().listen(${JSON.stringify(path)})`])
  while (!(await lstat(path).then((stats) => stats.isSocket(), () => false))) await Bun.sleep(50)
  listener.kill("SIGKILL")
  await listener.exited
}

const stop = async (child: Bun.Subprocess) => {
  child.kill("SIGTERM")
  const exited = await Promise.race([child.exited.then(() => true), Bun.sleep(10_000).then(() => false)])
  if (!exited) child.kill("SIGKILL")
  return exited
}

const build = (...args: Array<string>) => {
  const result = Bun.spawnSync(["bun", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
}

beforeAll(async () => {
  root = await mkdtemp("/tmp/xng-")
  home = join(root, "h")
  exangelos = join(root, "bin", "exangelos")
  xng = join(root, "bin", "xng")
  build("apps/cli/build.ts", "--version", version, "--outfile", exangelos)
  await symlink(exangelos, xng)
  const template = join(home, "plugins", "template")
  await mkdir(template, { recursive: true })
  build("build", "plugins/template/src/main.ts", "--target=bun", `--outfile=${join(template, "dist", "main.js")}`)
  await copyFile(join(repo, "plugins/template/plugin.json"), join(template, "plugin.json"))
}, 120_000)

afterAll(async () => {
  if (daemon !== undefined) await stop(daemon)
  await rm(root, { recursive: true, force: true })
})

describe("the exangelos binary", () => {
  it("prints its version under either name", () => {
    expect(run(exangelos, "--version")).toEqual({ status: 0, stdout: `exangelos ${version}\n`, stderr: "" })
    expect(run(xng, "--version")).toEqual({ status: 0, stdout: `exangelos ${version}\n`, stderr: "" })
  })

  it("says no daemon runs when none does", () => {
    const result = run(xng, "plugins")
    expect(result.status).toBe(1)
    expect(result.stdout).toBe("")
    expect(result.stderr.trim()).toBe(`no daemon runs on ${join(home, "daemon.sock")}`)
  })

  it("serves the template plugin's catalogue from a daemon that replaced a stale socket", async () => {
    await abandonSocket(join(home, "daemon.sock"))
    daemon = startDaemon()
    const plugins = JSON.parse((await listUntilReady()).stdout)
    expect(plugins).toMatchObject([
      {
        name: "template",
        trust: "enabled",
        process: "running",
        catalogue: { eventTypes: [{ type: "tick", description: "One tick of the countdown" }] }
      }
    ])
    const socket = await lstat(join(home, "daemon.sock"))
    expect(socket.isSocket()).toBe(true)
    expect(socket.mode & 0o777).toBe(0o600)
    expect(pluginRuns()).toBe(true)
  }, 30_000)

  it("applied the migrations to the database", () => {
    const database = new Database(join(home, "exangelos.db"), { readonly: true })
    const tables = database.query<{ name: string }, []>("select name from sqlite_master where type = 'table'").all()
    const migrations = database.query<{ migration_id: number }, []>("select migration_id from effect_sql_migrations").all()
    database.close()
    expect(tables.map((table) => table.name)).toEqual(
      expect.arrayContaining(["plugins", "plugin_values", "plugin_changes", "subscriptions", "events", "wakes"])
    )
    expect(migrations).toEqual([{ migration_id: 1 }])
  })

  it("refuses a second daemon beside a live one", () => {
    const second = run(exangelos, "daemon")
    expect(second.status).toBe(1)
    expect(second.stderr.trim()).toBe(`a daemon already runs on ${join(home, "daemon.sock")}`)
    expect(run(exangelos, "plugins").status).toBe(0)
  })

  it("stops with its plugin and leaves no daemon behind", async () => {
    expect(await stop(daemon!)).toBe(true)
    daemon = undefined
    expect(pluginRuns()).toBe(false)
    expect(run(exangelos, "plugins").stderr.trim()).toBe(`no daemon runs on ${join(home, "daemon.sock")}`)
  }, 15_000)

  it("cross-compiles for Linux x64 into an ELF executable", async () => {
    const linux = join(root, "bin", "exangelos-linux-x64")
    build("apps/cli/build.ts", "--target=bun-linux-x64", "--outfile", linux)
    expect((await readFile(linux)).subarray(0, 4)).toEqual(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
  }, 120_000)
})
