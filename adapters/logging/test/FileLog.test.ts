import * as Fs from "node:fs"
import * as Os from "node:os"
import * as Path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest"
import { FileLog } from "../src/index.ts"

let dir = ""

beforeEach(() => {
  dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), "exangelos-logging-"))
})

afterEach(() => Fs.rmSync(dir, { recursive: true, force: true }))

const line = (n: number) => JSON.stringify({ n, pad: "x".repeat(40) })

describe("FileLog.sink", () => {
  it("rotates at the size threshold and keeps the given number of old files", () => {
    const logs = Path.join(dir, "logs")
    const sink = FileLog.sink({ dir: logs, src: "daemon", maxBytes: 100, keep: 2 })
    for (let n = 0; n < 10; n++) sink.write(line(n))
    expect(Fs.readdirSync(logs).sort()).toEqual(["daemon.1.jsonl", "daemon.2.jsonl", "daemon.jsonl"])
    const read = (name: string) => Fs.readFileSync(Path.join(logs, name), "utf8").trim().split("\n").map((l) => JSON.parse(l).n)
    expect(read("daemon.jsonl")).toEqual([8, 9])
    expect(read("daemon.1.jsonl")).toEqual([6, 7])
    expect(read("daemon.2.jsonl")).toEqual([4, 5])
    expect(Fs.statSync(Path.join(logs, "daemon.jsonl")).mode & 0o777).toBe(0o600)
    expect(Fs.statSync(logs).mode & 0o777).toBe(0o700)
  })

  it("narrows an existing log and its directory to the owner before writing", () => {
    const logs = Path.join(dir, "logs")
    Fs.mkdirSync(logs, { mode: 0o755 })
    Fs.writeFileSync(Path.join(logs, "cli.jsonl"), "", { mode: 0o644 })
    Fs.writeFileSync(Path.join(logs, "cli.1.jsonl"), "", { mode: 0o644 })
    FileLog.sink({ dir: logs, src: "cli" }).write(line(1))
    expect(Fs.statSync(logs).mode & 0o777).toBe(0o700)
    expect(Fs.statSync(Path.join(logs, "cli.jsonl")).mode & 0o777).toBe(0o600)
    expect(Fs.statSync(Path.join(logs, "cli.1.jsonl")).mode & 0o777).toBe(0o600)
  })

  it("drops records it cannot write and reports that once", () => {
    const blocked = Path.join(dir, "blocked")
    Fs.writeFileSync(blocked, "")
    const reports: Array<string> = []
    const sink = FileLog.sink({ dir: blocked, src: "cli", report: (message) => reports.push(message) })
    sink.write(line(1))
    sink.write(line(2))
    expect(reports).toHaveLength(1)
  })
})
